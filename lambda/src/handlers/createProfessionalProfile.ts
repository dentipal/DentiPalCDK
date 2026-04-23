import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    PutItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { extractUserFromBearerToken } from "./utils";
import { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } from "./professionalRoles";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// --- Type Definitions ---

interface ProfessionalProfileData {
    role: string;
    first_name: string;
    last_name: string;
    specialties?: string[];
    [key: string]: any;
}

interface AddressData {
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    state?: string;
    pincode?: string | number;
    country?: string;
    addressType?: string;
    isDefault?: boolean;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Lambda Handler ---
// Accepts a consolidated payload:
//   { "profile": { first_name, last_name, role, ... }, "address": { addressLine1, city, ... } }
// Writes profile → PROFESSIONAL_PROFILES_TABLE
// Writes address → USER_ADDRESSES_TABLE  (if valid address fields are present)

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    const method = (event.requestContext as any).http?.method || event.httpMethod || "POST";

    // CORS preflight
    if (method === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // ─── Step 1: Authenticate ───────────────────────────────────────────────
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            if (!authHeader) throw new Error("Authorization header is missing");
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            console.error("[createProfessionalProfile] Auth error:", authError.message);
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: authError.message || "Invalid access token" }),
            };
        }

        // ─── Step 2: Parse body ─────────────────────────────────────────────────
        let profileData: ProfessionalProfileData;
        let addressData: AddressData | undefined;

        try {
            let bodyString = event.body;
            if (event.isBase64Encoded && bodyString) {
                bodyString = Buffer.from(bodyString, 'base64').toString('utf-8');
            }

            const parsedBody = JSON.parse(bodyString || '{}');
            console.log("[createProfessionalProfile] Raw body:", JSON.stringify(parsedBody));

            // Support nested payload { profile: {...}, address: {...} }
            // AND legacy flat payload { first_name, last_name, role, ... }
            const rawProfile = parsedBody.profile ?? parsedBody;
            addressData = parsedBody.address ?? undefined;

            profileData = {
                ...rawProfile,
                // Support both camelCase (frontend) and snake_case (backend)
                first_name: rawProfile.first_name || rawProfile.firstName || "",
                last_name:  rawProfile.last_name  || rawProfile.lastName  || "",
                role:       rawProfile.role || "",
            };
        } catch (parseError) {
            console.error("[createProfessionalProfile] Body parse error:", parseError);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Invalid JSON in request body" }),
            };
        }

        console.log("[createProfessionalProfile] profileData:", JSON.stringify(profileData));
        console.log("[createProfessionalProfile] addressData:", JSON.stringify(addressData));

        // ─── Step 3: Validate profile fields ───────────────────────────────────
        const missingFields: string[] = [];
        if (!profileData.first_name?.trim()) missingFields.push("first_name");
        if (!profileData.last_name?.trim())  missingFields.push("last_name");
        if (!profileData.role?.trim())        missingFields.push("role");

        if (missingFields.length > 0) {
            console.warn("[createProfessionalProfile] Missing fields:", missingFields);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Required fields are missing or empty",
                    details: { missingFields, received: profileData },
                }),
            };
        }

        // ─── Step 4: Validate role ──────────────────────────────────────────────
        if (!VALID_ROLE_VALUES.includes(profileData.role)) {
            console.warn("[createProfessionalProfile] Invalid role:", profileData.role);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: `Invalid role. Valid options: ${VALID_ROLE_VALUES.map(
                        (r) => DB_TO_DISPLAY_MAPPING[r] || r
                    ).join(", ")}`,
                }),
            };
        }

        const timestamp = new Date().toISOString();

        // ─── Step 5: Build profile DynamoDB item ────────────────────────────────
        const profileItem: Record<string, AttributeValue> = {
            userSub:    { S: userSub },
            role:       { S: profileData.role },
            first_name: { S: profileData.first_name.trim() },
            last_name:  { S: profileData.last_name.trim() },
            createdAt:  { S: timestamp },
            updatedAt:  { S: timestamp },
        };

        // Add any additional dynamic fields from the profile payload
        const excludeKeys = new Set(["role", "first_name", "last_name", "firstName", "lastName", "specialties"]);
        Object.entries(profileData).forEach(([key, value]) => {
            if (excludeKeys.has(key) || value === undefined || value === null) return;
            if (typeof value === "string" && value.trim() !== "") {
                profileItem[key] = { S: value };
            } else if (typeof value === "boolean") {
                profileItem[key] = { BOOL: value };
            } else if (typeof value === "number") {
                profileItem[key] = { N: value.toString() };
            } else if (Array.isArray(value)) {
                const strings = value.filter((v): v is string => typeof v === "string" && v.trim() !== "");
                if (strings.length > 0) profileItem[key] = { SS: strings };
            }
        });

        // Specialties as a string set
        if (Array.isArray(profileData.specialties) && profileData.specialties.length > 0) {
            const specialties = profileData.specialties.filter((s): s is string => typeof s === "string" && s.trim() !== "");
            if (specialties.length > 0) profileItem.specialties = { SS: specialties };
        }

        // ─── Step 6: Write profile to PROFESSIONAL_PROFILES_TABLE ──────────────
        await dynamodb.send(
            new PutItemCommand({
                TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                Item: profileItem,
                ConditionExpression: "attribute_not_exists(userSub)",
            })
        );
        console.log("[createProfessionalProfile] ✅ Profile saved for userSub:", userSub);

        // ─── Step 7: Write address to USER_ADDRESSES_TABLE (if provided) ────────
        const hasValidAddress =
            addressData &&
            addressData.addressLine1?.trim() &&
            addressData.city?.trim() &&
            addressData.state?.trim() &&
            addressData.pincode;

        if (hasValidAddress) {
            const addressItem: Record<string, AttributeValue> = {
                userSub:      { S: userSub },
                addressLine1: { S: addressData!.addressLine1!.trim() },
                city:         { S: addressData!.city!.trim() },
                state:        { S: addressData!.state!.trim() },
                pincode:      { S: String(addressData!.pincode).trim() },
                country:      { S: (addressData!.country || "USA").trim() },
                addressType:  { S: (addressData!.addressType || "home").trim() },
                isDefault:    { BOOL: addressData!.isDefault !== false },
                createdAt:    { S: timestamp },
                updatedAt:    { S: timestamp },
            };

            if (addressData!.addressLine2?.trim()) {
                addressItem.addressLine2 = { S: addressData!.addressLine2.trim() };
            }
            if (addressData!.addressLine3?.trim()) {
                addressItem.addressLine3 = { S: addressData!.addressLine3.trim() };
            }

            try {
                // No ConditionExpression — multiple users can share addresses freely
                // (removed the buggy ScanCommand that blocked same-pincode users)
                await dynamodb.send(
                    new PutItemCommand({
                        TableName: process.env.USER_ADDRESSES_TABLE,
                        Item: addressItem,
                    })
                );
                console.log("[createProfessionalProfile] ✅ Address saved for userSub:", userSub);
            } catch (addressErr) {
                // Non-fatal — log but don't fail the profile creation
                console.error("[createProfessionalProfile] ⚠️ Address write failed (non-fatal):", addressErr);
            }
        } else {
            console.log("[createProfessionalProfile] No valid address provided, skipping address write.");
        }

        // ─── Step 8: Return success ─────────────────────────────────────────────
        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Professional profile created successfully",
                userSub,
                role: profileData.role,
                first_name: profileData.first_name,
                last_name: profileData.last_name,
                addressSaved: !!hasValidAddress,
            }),
        };

    } catch (error) {
        const err = error as Error;
        console.error("[createProfessionalProfile] Uncaught error:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 409,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Professional profile already exists for this user" }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: err.message || "An unexpected error occurred" }),
        };
    }
};
