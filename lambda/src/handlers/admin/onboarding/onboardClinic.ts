import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminAddUserToGroupCommand,
    AdminGetUserCommand,
    AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
    DynamoDBClient,
    PutItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { corsHeaders } from "../../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
    buildAddress,
} from "../../utils";
import { geocodeAddressParts } from "../../geo";
import {
    generateTempPassword,
    sendClinicInviteEmail,
} from "./inviteEmail";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface ClinicSection {
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
    practice_type?: string;
    primary_practice_area?: string;
    primary_contact_title?: string;
    number_of_operatories?: number;
    num_hygienists?: number;
    num_assistants?: number;
    num_doctors?: number;
    dental_association?: string;
    software_used?: string[];
    parking_type?: string;
    free_parking_available?: boolean;
    parking_cost?: number;
    notes?: string;
    website?: string;
}

interface OnboardClinicBody {
    email?: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    // Bulk-multi-clinic mode: admin can register the owner + N clinics in one call.
    // Empty/absent array → "Account only" onboarding (no Clinics rows written).
    clinics?: ClinicSection[];
    // Back-compat: accept a single `clinic` from older callers and treat it as
    // a 1-element clinics array. Not used by the current admin UI.
    clinic?: ClinicSection;
}

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

const validateClinicSection = (c: ClinicSection, index: number): string[] => {
    const missing: string[] = [];
    if (!c.name) missing.push(`clinics[${index}].name`);
    if (!c.addressLine1) missing.push(`clinics[${index}].addressLine1`);
    if (!c.city) missing.push(`clinics[${index}].city`);
    if (!c.state) missing.push(`clinics[${index}].state`);
    if (!c.pincode) missing.push(`clinics[${index}].pincode`);
    return missing;
};

interface ClinicWriteResult {
    clinicId: string;
    name: string;
    clinicCreated: boolean;
    clinicProfileCreated: boolean;
}

// Writes a single Clinics row (+ optional Clinic-Profiles row) for the supplied
// ownerSub. Mirrors createClinic.ts exactly so both code paths produce
// row-identical data.
const writeClinic = async (
    clinic: ClinicSection,
    ownerSub: string,
    ownerFirstName: string,
    ownerLastName: string
): Promise<ClinicWriteResult> => {
    const clinicId = uuidv4();
    const timestamp = new Date().toISOString();
    const address = buildAddress({
        addressLine1: clinic.addressLine1!,
        addressLine2: clinic.addressLine2,
        addressLine3: clinic.addressLine3,
        city: clinic.city!,
        state: clinic.state!,
        pincode: clinic.pincode!,
    });

    let coords: { lat: number; lng: number } | null = null;
    try {
        coords = await geocodeAddressParts({
            addressLine1: clinic.addressLine1!,
            city: clinic.city!,
            state: clinic.state!,
            pincode: clinic.pincode!,
        });
    } catch (geoErr) {
        console.warn("[onboardClinic] geocode failed (non-fatal):", geoErr);
    }

    const assocType = (process.env.ASSOCIATED_USERS_TYPE || "L").toUpperCase();
    const AssociatedUsers: AttributeValue = assocType === "SS"
        ? { SS: [ownerSub] }
        : { L: [{ S: ownerSub }] };

    const clinicItem: Record<string, AttributeValue> = {
        clinicId:     { S: clinicId },
        name:         { S: clinic.name! },
        addressLine1: { S: clinic.addressLine1! },
        addressLine2: { S: clinic.addressLine2 || "" },
        addressLine3: { S: clinic.addressLine3 || "" },
        city:         { S: clinic.city!.trim() },
        state:        { S: clinic.state!.trim() },
        pincode:      { S: clinic.pincode!.trim() },
        address:      { S: address },
        createdBy:    { S: ownerSub },
        createdAt:    { S: timestamp },
        updatedAt:    { S: timestamp },
        AssociatedUsers,
    };
    if (coords) {
        clinicItem.lat = { N: String(coords.lat) };
        clinicItem.lng = { N: String(coords.lng) };
    }

    let clinicCreated = false;
    try {
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Item: clinicItem,
            ConditionExpression: "attribute_not_exists(clinicId)",
        }));
        clinicCreated = true;
    } catch (clinicErr) {
        // Single-clinic failure must not abort the rest of the loop or the
        // Cognito user. Log and continue — the admin can retry the failed
        // clinic via the user's own /add-clinic flow.
        console.error(`[onboardClinic] clinic write failed for "${clinic.name}":`, clinicErr);
        return { clinicId, name: clinic.name!, clinicCreated: false, clinicProfileCreated: false };
    }

    const hasProfileFields =
        clinic.practice_type || clinic.primary_practice_area ||
        clinic.number_of_operatories !== undefined ||
        clinic.num_hygienists !== undefined ||
        clinic.num_assistants !== undefined ||
        clinic.num_doctors !== undefined ||
        clinic.software_used?.length ||
        clinic.parking_type || clinic.free_parking_available !== undefined ||
        clinic.parking_cost !== undefined ||
        clinic.dental_association || clinic.notes || clinic.website;

    let clinicProfileCreated = false;
    if (hasProfileFields && process.env.CLINIC_PROFILES_TABLE) {
        try {
            const profileItem: Record<string, AttributeValue> = {
                clinicId:                    { S: clinicId },
                userSub:                     { S: ownerSub },
                clinic_name:                 { S: clinic.name! },
                practice_type:               { S: clinic.practice_type || "general" },
                primary_practice_area:       { S: clinic.primary_practice_area || "General Dentistry" },
                primary_contact_first_name:  { S: ownerFirstName },
                primary_contact_last_name:   { S: ownerLastName },
                createdAt:                   { S: timestamp },
                updatedAt:                   { S: timestamp },
            };
            if (clinic.primary_contact_title) profileItem.title = { S: clinic.primary_contact_title };
            if (clinic.number_of_operatories !== undefined) profileItem.number_of_operatories = { N: String(clinic.number_of_operatories) };
            if (clinic.num_hygienists !== undefined)        profileItem.num_hygienists        = { N: String(clinic.num_hygienists) };
            if (clinic.num_assistants !== undefined)        profileItem.num_assistants        = { N: String(clinic.num_assistants) };
            if (clinic.num_doctors !== undefined)           profileItem.num_doctors           = { N: String(clinic.num_doctors) };
            if (clinic.dental_association)                  profileItem.dental_association    = { S: clinic.dental_association };
            if (clinic.software_used?.length)               profileItem.software_used         = { SS: clinic.software_used };
            if (clinic.parking_type)                        profileItem.parking_type          = { S: clinic.parking_type };
            if (clinic.free_parking_available !== undefined) profileItem.free_parking_available = { BOOL: clinic.free_parking_available };
            if (clinic.parking_cost !== undefined)          profileItem.parking_cost          = { N: String(clinic.parking_cost) };
            if (clinic.notes)                               profileItem.notes                 = { S: clinic.notes };
            if (clinic.website)                             profileItem.website               = { S: clinic.website };
            profileItem.addressLine1 = { S: clinic.addressLine1! };
            profileItem.city         = { S: clinic.city! };
            profileItem.state        = { S: clinic.state! };
            profileItem.zip_code     = { S: clinic.pincode! };

            await dynamodb.send(new PutItemCommand({
                TableName: process.env.CLINIC_PROFILES_TABLE,
                Item: profileItem,
            }));
            clinicProfileCreated = true;
        } catch (profileErr) {
            console.error("[onboardClinic] clinic profile write failed (non-fatal):", profileErr);
        }
    }

    return { clinicId, name: clinic.name!, clinicCreated, clinicProfileCreated };
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!requireInternalGroup(caller.groups, ["Admin", "HR"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin or HR role required." });
        }

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: OnboardClinicBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { firstName, lastName, phoneNumber } = body;

        const missing = [
            !email && "email",
            !firstName && "firstName",
            !lastName && "lastName",
            !phoneNumber && "phoneNumber",
        ].filter(Boolean);
        if (missing.length > 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Required fields are missing",
                details: { missingFields: missing },
            });
        }
        if (!E164_REGEX.test(phoneNumber!)) {
            return json(event, 400, {
                error: "Bad Request",
                message: "phoneNumber must be in E.164 format (e.g. +14155551234)",
            });
        }

        // Normalize input — accept clinics[] (preferred) OR a single clinic
        // (back-compat for the previous single-clinic UI).
        const clinics: ClinicSection[] = Array.isArray(body.clinics)
            ? body.clinics
            : body.clinic
                ? [body.clinic]
                : [];

        // Validate every clinic section upfront so we don't create the Cognito
        // user only to reject a malformed clinic body.
        if (clinics.length > 0) {
            const allMissing: string[] = [];
            clinics.forEach((c, i) => allMissing.push(...validateClinicSection(c, i)));
            if (allMissing.length > 0) {
                return json(event, 400, {
                    error: "Bad Request",
                    message: "One or more clinic sections are missing required fields",
                    details: { missingFields: allMissing },
                });
            }
        }

        const userAttributes = [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "given_name", Value: firstName! },
            { Name: "family_name", Value: lastName! },
            { Name: "phone_number", Value: phoneNumber! },
            { Name: "address", Value: "userType:clinic|role:root" },
        ];

        // Generate the temp password ourselves so we can suppress Cognito's
        // plain default email and send our branded SES one. Cognito will still
        // require this exact password on first sign-in.
        const tempPassword = generateTempPassword();

        let createdUsername: string | undefined;
        let newUserSub = "";
        try {
            const createResp = await cognito.send(new AdminCreateUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                UserAttributes: userAttributes,
                TemporaryPassword: tempPassword,
                MessageAction: "SUPPRESS",
            }));
            createdUsername = createResp.User?.Username || email;
            newUserSub = createResp.User?.Attributes?.find(a => a.Name === "sub")?.Value || "";

            // Clinic-side primary user joins the Root group — matches what the
            // existing self-signup flow does in initiateUserRegistration.ts.
            await cognito.send(new AdminAddUserToGroupCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                GroupName: "Root",
            }));
        } catch (innerError: any) {
            if (createdUsername && innerError.name !== "UsernameExistsException") {
                try {
                    await cognito.send(new AdminDeleteUserCommand({
                        UserPoolId: process.env.USER_POOL_ID!,
                        Username: createdUsername,
                    }));
                } catch (rollbackError) {
                    console.error("[onboardClinic] rollback failed:", rollbackError);
                }
            }
            throw innerError;
        }

        if (!newUserSub) {
            const fresh = await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
            }));
            newUserSub = fresh.UserAttributes?.find(a => a.Name === "sub")?.Value || "";
        }

        // Send the branded invite email. SES failures are non-fatal — the user
        // already exists in Cognito and the admin can re-trigger via
        // AdminResetUserPassword if delivery breaks.
        try {
            await sendClinicInviteEmail({
                firstName,
                email,
                tempPassword,
            });
        } catch (mailErr) {
            console.error("[onboardClinic] invite email send failed (Cognito user kept):", mailErr);
        }

        // Write each clinic. Failures of individual clinics do NOT delete the
        // Cognito user — the owner can finish in /add-clinic after their
        // forced password reset. Sequential rather than parallel so the
        // geocode + DDB ops don't all spike at once for an owner with many
        // clinics, and so the response can show a deterministic order.
        const results: ClinicWriteResult[] = [];
        if (newUserSub) {
            for (const c of clinics) {
                const res = await writeClinic(c, newUserSub, firstName!, lastName!);
                results.push(res);
            }
        }

        const clinicsCreated = results.filter(r => r.clinicCreated).length;
        const profilesCreated = results.filter(r => r.clinicProfileCreated).length;

        return json(event, 200, {
            status: "success",
            message: `Clinic invitation sent to ${email}${clinicsCreated > 0 ? ` (${clinicsCreated} clinic${clinicsCreated === 1 ? "" : "s"} created)` : ""}`,
            data: {
                email,
                sub: newUserSub,
                cognitoGroup: "Root",
                status: "FORCE_CHANGE_PASSWORD",
                clinicsRequested: clinics.length,
                clinicsCreated,
                clinicProfilesCreated: profilesCreated,
                clinics: results,
                // Back-compat fields for any caller still reading the old shape.
                clinicId: results[0]?.clinicId,
                clinicCreated: clinicsCreated > 0,
                clinicProfileCreated: profilesCreated > 0,
            },
        });
    } catch (error: any) {
        console.error("[onboardClinic] error:", error);
        if (error.name === "UsernameExistsException") {
            return json(event, 409, {
                error: "Conflict",
                message: "A user with this email already exists.",
            });
        }
        if (error.name === "InvalidParameterException") {
            return json(event, 400, {
                error: "Bad Request",
                message: error.message || "Invalid parameters",
            });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to onboard clinic",
        });
    }
};
