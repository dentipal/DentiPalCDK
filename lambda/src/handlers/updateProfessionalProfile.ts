import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    AttributeValue,
    GetItemCommandInput,
    UpdateItemCommandInput,
    GetItemCommandOutput,
    UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand } from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const eb: EventBridgeClient = new EventBridgeClient({ region: REGION });
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
const JOB_APPLICATIONS_TABLE: string | undefined = process.env.JOB_APPLICATIONS_TABLE;
const JOB_INVITATIONS_TABLE: string | undefined = process.env.JOB_INVITATIONS_TABLE;

// Fields whose change is worth a notification to clinics with an active
// relationship to the pro. Excludes cosmetic / contact fields (avatar, bio,
// phone) — those would create noise. Keep in sync with whatever the clinic
// sees on the JobApplicantsPage / pro profile card.
const MATERIAL_PROFILE_FIELDS = new Set<string>([
    "first_name",
    "last_name",
    "professional_role",
    "role",
    "yearsExperience",
    "hourly_rate",
    "hourlyRate",
    "rate",
    "hygienist_license_file",
    "license_number",
]);

// Human-readable label for the notification body. Anything missing falls
// back to the raw field key.
const FIELD_LABEL: Record<string, string> = {
    first_name: "name",
    last_name: "name",
    professional_role: "role",
    role: "role",
    yearsExperience: "experience",
    hourly_rate: "rate",
    hourlyRate: "rate",
    rate: "rate",
    hygienist_license_file: "license",
    license_number: "license",
};

// --- 2. Validation primitives (mirror dentipal/src/schemas/profileValidation.ts) ---
const NAME_REGEX = /^[a-zA-Z\s'-]{2,50}$/;
const PHONE_REGEX = /^\+?\d{10,15}$/;
const LICENSE_REGEX = /^[A-Z0-9-]{4,20}$/i;
const BIO_MAX = 500;
const QUALIFICATIONS_MAX = 500;
const YEARS_MIN = 0;
// Years-of-experience cap. MUST match the frontend constant YEARS_MAX in
// dentipal/src/schemas/profileValidation.ts so the UI and server agree.
const YEARS_MAX = 70;

const SPECIALIZATION_OPTIONS = [
    "General Dentistry",
    "Cosmetic Dentistry",
    "Endodontics",
    "Oral Surgery",
    "Pediatric Dentistry",
    "Orthodontics",
];

// Allowed weekday values for the Availability section's "Weekly Availability"
// selector. Keep canonical capitalized English so reads/writes don't have to
// case-normalize downstream. MUST match the frontend DAYS_OF_WEEK constant in
// dentipal/src/schemas/availabilitySchema.ts.
const AVAILABLE_DAY_OPTIONS = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
];

// Fields that clients cannot set/change via this endpoint.
const BLOCKED_FIELDS = new Set<string>(["userSub", "createdAt", "email", "role"]);

type Validator = (value: unknown) => { ok: true; out: AttributeValue } | { ok: false; error: string };

const validateString = (regex: RegExp, errMsg: string): Validator => (value) => {
    if (typeof value !== "string") return { ok: false, error: `Must be a string` };
    const trimmed = value.trim();
    if (!regex.test(trimmed)) return { ok: false, error: errMsg };
    return { ok: true, out: { S: trimmed } };
};

const validateFreeText = (max: number, allowEmpty = true): Validator => (value) => {
    if (typeof value !== "string") return { ok: false, error: "Must be a string" };
    if (!allowEmpty && value.trim() === "") return { ok: false, error: "Cannot be empty" };
    if (value.length > max) return { ok: false, error: `Max ${max} characters` };
    return { ok: true, out: { S: value } };
};

const validateInteger = (min: number, max: number): Validator => (value) => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(n)) return { ok: false, error: "Must be an integer" };
    if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}` };
    return { ok: true, out: { N: String(n) } };
};

const validateNumber = (min: number, max: number): Validator => (value) => {
    // Reject empty string / null outright — Number("") is 0, which would
    // otherwise sneak through as a silent default.
    if (value === "" || value === null) return { ok: false, error: "Required" };
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: "Must be a number" };
    if (n < min || n > max) return { ok: false, error: `Must be between ${min} and ${max}` };
    return { ok: true, out: { N: String(n) } };
};

const validateBoolean: Validator = (value) => {
    if (typeof value !== "boolean") return { ok: false, error: "Must be a boolean" };
    return { ok: true, out: { BOOL: value } };
};

// YYYY-MM-DD for the unavailable-dates list.
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const validateDateArray: Validator = (value) => {
    if (!Array.isArray(value)) return { ok: false, error: "Must be an array of YYYY-MM-DD strings" };
    if (value.length > 366) return { ok: false, error: "Too many blocked dates (max 366)" };
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") return { ok: false, error: "Each date must be a string" };
        const trimmed = item.trim();
        if (!trimmed) continue;
        if (!DATE_REGEX.test(trimmed)) return { ok: false, error: `Invalid date "${trimmed}" — use YYYY-MM-DD` };
        const d = new Date(trimmed + "T00:00:00Z");
        if (Number.isNaN(d.getTime())) return { ok: false, error: `"${trimmed}" is not a real calendar date` };
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
    }
    if (cleaned.length === 0) {
        // Empty → REMOVE the attribute. SS can't be empty in DynamoDB.
        return { ok: true, out: { NULL: true } };
    }
    return { ok: true, out: { SS: cleaned.sort() } };
};

const validateLicense: Validator = (value) => {
    if (typeof value !== "string") return { ok: false, error: "Must be a string" };
    const trimmed = value.trim();
    if (trimmed === "") return { ok: true, out: { S: "" } };
    if (!LICENSE_REGEX.test(trimmed)) return { ok: false, error: "4–20 alphanumeric characters or hyphens" };
    return { ok: true, out: { S: trimmed } };
};

const validateStringArray = (opts: {
    allowed?: string[];
    maxItems?: number;
}): Validator => (value) => {
    if (!Array.isArray(value)) return { ok: false, error: "Must be an array" };
    const cleaned: string[] = [];
    for (const item of value) {
        if (typeof item !== "string") return { ok: false, error: "Array items must be strings" };
        const trimmed = item.trim();
        if (trimmed === "") continue; // silently drop empty entries to prevent DynamoDB SS corruption
        if (opts.allowed && !opts.allowed.includes(trimmed)) {
            return { ok: false, error: `"${trimmed}" is not an allowed value` };
        }
        if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
    }
    if (opts.maxItems && cleaned.length > opts.maxItems) {
        return { ok: false, error: `Max ${opts.maxItems} items` };
    }
    if (cleaned.length === 0) {
        // Empty arrays cannot be stored as DynamoDB String Sets — signal caller to REMOVE this field.
        return { ok: true, out: { NULL: true } };
    }
    return { ok: true, out: { SS: cleaned } };
};

// --- 3. Allowlist of editable fields with their validators ---
const FIELD_VALIDATORS: Record<string, Validator> = {
    // Personal info
    first_name: validateString(NAME_REGEX, "Only letters, spaces, hyphens, apostrophes (2–50 chars)"),
    last_name: validateString(NAME_REGEX, "Only letters, spaces, hyphens, apostrophes (2–50 chars)"),
    phone: validateString(PHONE_REGEX, "Enter 10–15 digits (optional leading +)"),
    bio: validateFreeText(BIO_MAX),

    // Professional info
    yearsExperience: validateNumber(YEARS_MIN, YEARS_MAX),
    qualifications: validateFreeText(QUALIFICATIONS_MAX),
    skills: validateStringArray({ maxItems: 50 }),
    certificates: validateStringArray({ maxItems: 50 }),
    professionalCertificates: validateStringArray({ maxItems: 50 }),
    license_number: validateLicense,

    // Specializations (toggle grid)
    specializations: validateStringArray({ allowed: SPECIALIZATION_OPTIONS, maxItems: SPECIALIZATION_OPTIONS.length }),

    // Travel
    is_willing_to_travel: validateBoolean,
    max_travel_distance: validateInteger(0, 10000),

    // Availability — master toggle + weekday selection. Read by findJobs /
    // getProfessionalFilteredJobs (gate the pro's feed), getAllProfessionals
    // (hide opted-out pros from clinic listings), and createJobApplication
    // (reject applications while unavailable).
    is_available_for_jobs: validateBoolean,
    available_days: validateStringArray({ allowed: AVAILABLE_DAY_OPTIONS, maxItems: AVAILABLE_DAY_OPTIONS.length }),
    // Blocked calendar dates. Optional — when missing, the "any date"
    // behavior is preserved.
    unavailable_dates: validateDateArray,

    // Document keys (opaque S3 keys)
    resumeKey: validateFreeText(512),
    driversLicenseKey: validateFreeText(512),
    professionalLicenseKey: validateFreeText(512),
    introVideoKey: validateFreeText(512),
};

// --- 4. Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // Auth
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        if (!event.body) {
            return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "Request body is required." }) };
        }

        let updateData: Record<string, unknown>;
        try {
            updateData = JSON.parse(event.body);
        } catch {
            return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "Invalid JSON body" }) };
        }

        // Reject attempts to change immutable/locked fields
        const blocked = Object.keys(updateData).filter((k) => BLOCKED_FIELDS.has(k));
        if (blocked.length > 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "Some fields cannot be changed through this endpoint",
                    blockedFields: blocked,
                    hint: "email and role are set at signup. userSub/createdAt are immutable.",
                }),
            };
        }

        // Reject unknown fields outright (defense against field injection).
        // The FIELD_VALIDATORS map at the top of this file is the allowlist;
        // yearsExperience is already validated there by validateNumber(
        // YEARS_MIN, YEARS_MAX), so changing YEARS_MAX above is all that's
        // needed to move the cap.
        const unknown = Object.keys(updateData).filter(
            (k) => !FIELD_VALIDATORS[k] && !BLOCKED_FIELDS.has(k)
        );
        if (unknown.length > 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "Unknown fields are not accepted",
                    unknownFields: unknown,
                }),
            };
        }

        // Ensure profile exists
        const getCommand: GetItemCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } },
        };
        const existing: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getCommand));
        if (!existing.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: "Professional profile not found" }),
            };
        }

        // Validate each field and split into SET / REMOVE actions
        const setPairs: string[] = [];
        const removeNames: string[] = [];
        const names: Record<string, string> = {};
        const values: Record<string, AttributeValue> = {};
        const fieldErrors: Record<string, string> = {};

        for (const [key, raw] of Object.entries(updateData)) {
            if (raw === undefined) continue;
            const validator = FIELD_VALIDATORS[key];
            const result = validator(raw);
            if (!result.ok) {
                fieldErrors[key] = result.error;
                continue;
            }

            names[`#${key}`] = key;
            // NULL sentinel from validateStringArray means "the list is empty — remove the attribute"
            if ("NULL" in result.out && result.out.NULL === true) {
                removeNames.push(`#${key}`);
            } else {
                values[`:${key}`] = result.out;
                setPairs.push(`#${key} = :${key}`);
            }
        }

        if (Object.keys(fieldErrors).length > 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: "Validation failed", fieldErrors }),
            };
        }

        if (setPairs.length === 0 && removeNames.length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: "No fields to update" }),
            };
        }

        // Always bump updatedAt
        const nowIso = new Date().toISOString();
        names["#updatedAt"] = "updatedAt";
        values[":updatedAt"] = { S: nowIso };
        setPairs.push("#updatedAt = :updatedAt");

        const parts: string[] = [];
        if (setPairs.length > 0) parts.push(`SET ${setPairs.join(", ")}`);
        if (removeNames.length > 0) parts.push(`REMOVE ${removeNames.join(", ")}`);

        const updateCommand: UpdateItemCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: parts.join(" "),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined,
            ReturnValues: "ALL_NEW",
        };

        const result: UpdateItemCommandOutput = await dynamodb.send(new UpdateItemCommand(updateCommand));
        const updated = result.Attributes;

        // Best-effort: notify clinics with an active relationship to this pro
        // (open application or open invite) when a *material* field changed —
        // not on cosmetic edits like avatar/bio/phone. Quietly skip on lookup
        // failures so a transient blip never breaks the actual profile update.
        try {
            const changedKeys = Object.keys(updateData).filter((k) => updateData[k] !== undefined);
            const materialChanged = changedKeys.filter((k) => MATERIAL_PROFILE_FIELDS.has(k));
            if (materialChanged.length > 0 && JOB_APPLICATIONS_TABLE && JOB_INVITATIONS_TABLE) {
                const [appsResp, invitesResp] = await Promise.all([
                    dynamodb.send(new QueryCommand({
                        TableName: JOB_APPLICATIONS_TABLE,
                        IndexName: "ProfessionalIndex",
                        KeyConditionExpression: "professionalUserSub = :psub",
                        FilterExpression:
                            "applicationStatus IN (:pending, :negotiating, :scheduled, :accepted)",
                        ExpressionAttributeValues: {
                            ":psub": { S: userSub },
                            ":pending": { S: "pending" },
                            ":negotiating": { S: "negotiating" },
                            ":scheduled": { S: "scheduled" },
                            ":accepted": { S: "accepted" },
                        },
                    })).catch((err) => {
                        console.warn("[profile-updated] apps lookup failed:", (err as Error).message);
                        return undefined;
                    }),
                    dynamodb.send(new QueryCommand({
                        TableName: JOB_INVITATIONS_TABLE,
                        IndexName: "ProfessionalIndex",
                        KeyConditionExpression: "professionalUserSub = :psub",
                        FilterExpression:
                            "attribute_not_exists(invitationStatus) OR invitationStatus IN (:sent, :pending, :negotiating)",
                        ExpressionAttributeValues: {
                            ":psub": { S: userSub },
                            ":sent": { S: "sent" },
                            ":pending": { S: "pending" },
                            ":negotiating": { S: "negotiating" },
                        },
                    })).catch((err) => {
                        console.warn("[profile-updated] invites lookup failed:", (err as Error).message);
                        return undefined;
                    }),
                ]);

                const clinicIdSet = new Set<string>();
                for (const item of appsResp?.Items ?? []) {
                    const cid = item.clinicId?.S || item.ClinicId?.S;
                    if (cid) clinicIdSet.add(cid);
                }
                for (const item of invitesResp?.Items ?? []) {
                    const cid = item.clinicId?.S || item.ClinicId?.S;
                    if (cid) clinicIdSet.add(cid);
                }

                if (clinicIdSet.size > 0) {
                    const changedFields = Array.from(new Set(
                        materialChanged.map((k) => FIELD_LABEL[k] || k)
                    ));
                    const proName =
                        `${updated?.first_name?.S || ""} ${updated?.last_name?.S || ""}`.trim() ||
                        undefined;
                    await eb.send(new PutEventsCommand({
                        Entries: [{
                            Source: "denti-pal.api",
                            DetailType: "ShiftEvent",
                            Detail: JSON.stringify({
                                eventType: "profile-updated",
                                actor: "professional",
                                professionalSub: userSub,
                                professionalName: proName,
                                clinicIds: Array.from(clinicIdSet),
                                changedFields,
                            }),
                        }],
                    }));
                }
            }
        } catch (notifyErr) {
            console.warn("[updateProfessionalProfile] profile-updated publish failed (non-fatal):", (notifyErr as Error).message);
        }

        return {
            statusCode: 200,
            headers: corsHeaders(event),
            body: JSON.stringify({
                message: "Professional profile updated successfully",
                profile: {
                    userSub: updated?.userSub?.S,
                    role: updated?.role?.S,
                    first_name: updated?.first_name?.S,
                    last_name: updated?.last_name?.S,
                    updatedAt: updated?.updatedAt?.S || nowIso,
                },
            }),
        };
    } catch (error: any) {
        const err = error as Error;
        console.error("Error updating professional profile:", err.message, err.stack);

        if (error.message === "Authorization header missing" ||
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token") {
            return {
                statusCode: 401,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: error.message, details: error.message }),
            };
        }

        return {
            statusCode: 500,
            headers: corsHeaders(event),
            body: JSON.stringify({
                error: "Failed to update professional profile. Please try again.",
                details: err.message,
            }),
        };
    }
};
