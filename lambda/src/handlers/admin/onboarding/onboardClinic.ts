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

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface OnboardClinicBody {
    email?: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    clinic?: {
        // Required when admin opts into the "Account + clinic" mode.
        name?: string;
        addressLine1?: string;
        addressLine2?: string;
        addressLine3?: string;
        city?: string;
        state?: string;
        pincode?: string;
        country?: string;
        // Extended Clinic-Profile fields — all optional. Written to the
        // Clinic-Profiles table mirroring the POST /clinic-profiles contract.
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
    };
}

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!requireInternalGroup(caller.groups, ["Admin"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin role required." });
        }

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: OnboardClinicBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { firstName, lastName, phoneNumber, clinic } = body;

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

        if (clinic) {
            const clinicMissing = [
                !clinic.name && "clinic.name",
                !clinic.addressLine1 && "clinic.addressLine1",
                !clinic.city && "clinic.city",
                !clinic.state && "clinic.state",
                !clinic.pincode && "clinic.pincode",
            ].filter(Boolean);
            if (clinicMissing.length > 0) {
                return json(event, 400, {
                    error: "Bad Request",
                    message: "Clinic section is missing required fields",
                    details: { missingFields: clinicMissing },
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

        let createdUsername: string | undefined;
        let newUserSub = "";
        try {
            const createResp = await cognito.send(new AdminCreateUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                UserAttributes: userAttributes,
                DesiredDeliveryMediums: ["EMAIL"],
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

        let clinicCreated = false;
        let clinicProfileCreated = false;
        let clinicId: string | undefined;

        if (clinic && newUserSub) {
            clinicId = uuidv4();
            const timestamp = new Date().toISOString();
            const address = buildAddress({
                addressLine1: clinic.addressLine1!,
                addressLine2: clinic.addressLine2,
                addressLine3: clinic.addressLine3,
                city: clinic.city!,
                state: clinic.state!,
                pincode: clinic.pincode!,
            });

            // Geocode — best-effort, mirrors createClinic.ts
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
                ? { SS: [newUserSub] }
                : { L: [{ S: newUserSub }] };

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
                createdBy:    { S: newUserSub },
                createdAt:    { S: timestamp },
                updatedAt:    { S: timestamp },
                AssociatedUsers,
            };
            if (coords) {
                clinicItem.lat = { N: String(coords.lat) };
                clinicItem.lng = { N: String(coords.lng) };
            }

            try {
                await dynamodb.send(new PutItemCommand({
                    TableName: process.env.CLINICS_TABLE,
                    Item: clinicItem,
                    ConditionExpression: "attribute_not_exists(clinicId)",
                }));
                clinicCreated = true;
            } catch (clinicErr) {
                // Clinic write failure does NOT delete the Cognito user — the user
                // can complete /add-clinic themselves after first-login password reset.
                console.error("[onboardClinic] clinic write failed (Cognito user kept):", clinicErr);
            }

            // Optional: write Clinic-Profiles row if any extended fields were supplied.
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

            if (clinicCreated && hasProfileFields && process.env.CLINIC_PROFILES_TABLE) {
                try {
                    const profileItem: Record<string, AttributeValue> = {
                        clinicId:                    { S: clinicId },
                        userSub:                     { S: newUserSub },
                        clinic_name:                 { S: clinic.name! },
                        practice_type:               { S: clinic.practice_type || "general" },
                        primary_practice_area:       { S: clinic.primary_practice_area || "General Dentistry" },
                        primary_contact_first_name:  { S: firstName! },
                        primary_contact_last_name:   { S: lastName! },
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
        }

        return json(event, 200, {
            status: "success",
            message: `Clinic invitation sent to ${email}`,
            data: {
                email,
                sub: newUserSub,
                cognitoGroup: "Root",
                status: "FORCE_CHANGE_PASSWORD",
                clinicId: clinicId,
                clinicCreated,
                clinicProfileCreated,
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
