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
import { corsHeaders } from "../../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../../utils";
import {
    VALID_ROLE_VALUES,
    getRoleByDbValue,
} from "../../professionalRoles";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface OnboardProfessionalBody {
    email?: string;
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    role?: string;
    profile?: {
        yearsExperience?: number | string;
        skills?: string;
        qualifications?: string;
        license_number?: string;
        certificates1?: string;
        professionalCertificates?: string;
        addressLine1?: string;
        addressLine2?: string;
        addressLine3?: string;
        city?: string;
        state?: string;
        pincode?: string;
        country?: string;
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
        const body: OnboardProfessionalBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { firstName, lastName, phoneNumber, role, profile } = body;

        const missing = [
            !email && "email",
            !firstName && "firstName",
            !lastName && "lastName",
            !phoneNumber && "phoneNumber",
            !role && "role",
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
        if (!VALID_ROLE_VALUES.includes(role!)) {
            return json(event, 400, {
                error: "Bad Request",
                message: `Invalid role. Must be one of: ${VALID_ROLE_VALUES.join(", ")}`,
            });
        }
        const roleConfig = getRoleByDbValue(role!);
        if (!roleConfig) {
            return json(event, 400, {
                error: "Bad Request",
                message: `Unknown role: ${role}`,
            });
        }

        const userAttributes = [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "given_name", Value: firstName! },
            { Name: "family_name", Value: lastName! },
            { Name: "phone_number", Value: phoneNumber! },
            { Name: "address", Value: `userType:professional|role:${role}` },
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

            await cognito.send(new AdminAddUserToGroupCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                GroupName: roleConfig.cognitoGroup,
            }));
        } catch (innerError: any) {
            if (createdUsername && innerError.name !== "UsernameExistsException") {
                try {
                    await cognito.send(new AdminDeleteUserCommand({
                        UserPoolId: process.env.USER_POOL_ID!,
                        Username: createdUsername,
                    }));
                } catch (rollbackError) {
                    console.error("[onboardProfessional] rollback failed:", rollbackError);
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

        let profileCreated = false;
        if (profile && newUserSub) {
            try {
                const timestamp = new Date().toISOString();
                const profileItem: Record<string, AttributeValue> = {
                    userSub:    { S: newUserSub },
                    role:       { S: role! },
                    first_name: { S: firstName! },
                    last_name:  { S: lastName! },
                    createdAt:  { S: timestamp },
                    updatedAt:  { S: timestamp },
                };
                if (profile.yearsExperience !== undefined && profile.yearsExperience !== "") {
                    const ye = typeof profile.yearsExperience === "string"
                        ? parseInt(profile.yearsExperience, 10)
                        : profile.yearsExperience;
                    if (!isNaN(ye)) profileItem.yearsExperience = { N: String(ye) };
                }
                const optionalStrings: Array<keyof NonNullable<OnboardProfessionalBody["profile"]>> = [
                    "skills", "qualifications", "license_number",
                    "certificates1", "professionalCertificates",
                ];
                for (const key of optionalStrings) {
                    const v = profile[key];
                    if (typeof v === "string" && v.trim() !== "") {
                        profileItem[key as string] = { S: v.trim() };
                    }
                }

                await dynamodb.send(new PutItemCommand({
                    TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                    Item: profileItem,
                    ConditionExpression: "attribute_not_exists(userSub)",
                }));

                const hasAddress = profile.addressLine1?.trim()
                    && profile.city?.trim()
                    && profile.state?.trim()
                    && profile.pincode;
                if (hasAddress && process.env.USER_ADDRESSES_TABLE) {
                    const addressItem: Record<string, AttributeValue> = {
                        userSub:      { S: newUserSub },
                        addressLine1: { S: profile.addressLine1!.trim() },
                        city:         { S: profile.city!.trim() },
                        state:        { S: profile.state!.trim() },
                        pincode:      { S: String(profile.pincode).trim() },
                        country:      { S: (profile.country || "USA").trim() },
                        addressType:  { S: "home" },
                        isDefault:    { BOOL: true },
                        createdAt:    { S: timestamp },
                        updatedAt:    { S: timestamp },
                    };
                    if (profile.addressLine2?.trim()) addressItem.addressLine2 = { S: profile.addressLine2.trim() };
                    if (profile.addressLine3?.trim()) addressItem.addressLine3 = { S: profile.addressLine3.trim() };
                    try {
                        await dynamodb.send(new PutItemCommand({
                            TableName: process.env.USER_ADDRESSES_TABLE,
                            Item: addressItem,
                        }));
                    } catch (addrErr) {
                        console.error("[onboardProfessional] address write failed (non-fatal):", addrErr);
                    }
                }

                profileCreated = true;
            } catch (profileErr) {
                // Profile write failure does NOT delete the Cognito user — the user
                // can fill in their own profile after first login.
                console.error("[onboardProfessional] profile write failed (Cognito user kept):", profileErr);
            }
        }

        return json(event, 200, {
            status: "success",
            message: `Professional invitation sent to ${email}`,
            data: {
                email,
                role,
                cognitoGroup: roleConfig.cognitoGroup,
                sub: newUserSub,
                status: "FORCE_CHANGE_PASSWORD",
                profileCreated,
            },
        });
    } catch (error: any) {
        console.error("[onboardProfessional] error:", error);
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
            message: error?.message || "Failed to onboard professional",
        });
    }
};
