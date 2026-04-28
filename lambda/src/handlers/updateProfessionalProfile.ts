import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    AttributeValue,
    GetItemCommandInput,
    UpdateItemCommandInput,
    GetItemCommandOutput,
    UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;

// --- 2. Validation primitives (mirror dentipal/src/schemas/profileValidation.ts) ---
const NAME_REGEX = /^[a-zA-Z\s'-]{2,50}$/;
const PHONE_REGEX = /^\+?\d{10,15}$/;
const LICENSE_REGEX = /^[A-Z0-9-]{4,20}$/i;
const BIO_MAX = 500;
const QUALIFICATIONS_MAX = 500;
const YEARS_MIN = 0;
const YEARS_MAX = 60;

const SPECIALIZATION_OPTIONS = [
    "General Dentistry",
    "Cosmetic Dentistry",
    "Endodontics",
    "Oral Surgery",
    "Pediatric Dentistry",
    "Orthodontics",
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

    // Document keys (opaque S3 keys)
    resumeKey: validateFreeText(512),
    driversLicenseKey: validateFreeText(512),
    professionalLicenseKey: validateFreeText(512),
    introVideoKey: validateFreeText(512),
};

// --- 4. Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Auth
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        if (!event.body) {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Request body is required." }) };
        }

        let updateData: Record<string, unknown>;
        try {
            updateData = JSON.parse(event.body);
        } catch {
            return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid JSON body" }) };
        }

        // Reject attempts to change immutable/locked fields
        const blocked = Object.keys(updateData).filter((k) => BLOCKED_FIELDS.has(k));
        if (blocked.length > 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Some fields cannot be changed through this endpoint",
                    blockedFields: blocked,
                    hint: "email and role are set at signup. userSub/createdAt are immutable.",
                }),
            };
        }

        // Reject unknown fields outright (defense against field injection)
        const unknown = Object.keys(updateData).filter(
            (k) => !FIELD_VALIDATORS[k] && !BLOCKED_FIELDS.has(k)
        );
        if (unknown.length > 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
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
                headers: CORS_HEADERS,
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
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Validation failed", fieldErrors }),
            };
        }

        if (setPairs.length === 0 && removeNames.length === 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
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

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
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
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: error.message, details: error.message }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Failed to update professional profile. Please try again.",
                details: err.message,
            }),
        };
    }
};
