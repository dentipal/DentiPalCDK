import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";

const REGION: string = process.env.REGION || "us-east-1";
const CLINIC_PROFILES_TABLE: string = process.env.CLINIC_PROFILES_TABLE!; 

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Transformer ---
const transformBody = (body: any): any => {
    const transformed: any = {};
    const mapping: Record<string, string> = {
        clinicName: "clinic_name",
        primaryContactFirstName: "primary_contact_first_name",
        primaryContactLastName: "primary_contact_last_name",
        practiceType: "practice_type",
        primaryPracticeArea: "primary_practice_area",
        parkingType: "parking_type",
        bookingOutPeriod: "booking_out_period",
        softwareUsed: "software_used",
        numberOfOperatories: "number_of_operatories",
        numAssistants: "num_assistants",
        numDoctors: "num_doctors",
        numHygienists: "num_hygienists",
        assistedHygieneAvailable: "assisted_hygiene_available",
        freeParkingAvailable: "free_parking_available",
        insurancePlansAccepted: "insurance_plans_accepted",
        notes: "description",
        website: "website",
        dentalAssociation: "dental_association",
        addressLine1: "address_line_1",
        city: "city",
        state: "state",
        zipCode: "zip_code",
        phone: "clinic_phone",
        email: "clinic_email"
    };

    if (body.location) {
        if (body.location.addressLine1) transformed.address_line_1 = body.location.addressLine1;
        if (body.location.city) transformed.city = body.location.city;
        if (body.location.state) transformed.state = body.location.state;
        if (body.location.zipCode) transformed.zip_code = body.location.zipCode;
    }
    if (body.contactInfo) {
        if (body.contactInfo.phone) transformed.clinic_phone = body.contactInfo.phone;
        if (body.contactInfo.email) transformed.clinic_email = body.contactInfo.email;
    }

    for (const [key, value] of Object.entries(body)) {
        if (mapping[key]) {
            transformed[mapping[key]] = value;
        } else if (Object.values(mapping).includes(key) || key === "clinic_id") {
             transformed[key] = value;
        }
    }
    return transformed;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🔧 Starting updateClinicProfile handler");

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // 🛑 CRITICAL FIX: Check if body is null immediately
    if (!event.body) {
        console.error("❌ Request body is NULL. Client likely sent a GET request instead of PUT/POST.");
        return json(400, { 
            error: "Request body is missing.", 
            details: "You must send a JSON payload. Ensure you are using PUT or POST method, not GET." 
        });
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const loggedInUserSub = userInfo.sub; 
        const groups = userInfo.groups || [];

        // --- ID Extraction ---
        let clinicIdFromPath = event.pathParameters?.clinicId;
        if (!clinicIdFromPath && (event.pathParameters?.proxy || event.path)) {
            const rawPath = event.pathParameters?.proxy || event.path;
            const pathParts = rawPath.split("/").filter(Boolean);
            const clinicsIndex = pathParts.findIndex(p => p === "clinics" || p === "clinic-profiles");
            if (clinicsIndex !== -1 && pathParts.length > clinicsIndex + 1) {
                clinicIdFromPath = pathParts[clinicsIndex + 1];
            } else if (pathParts[pathParts.length - 1] === 'profile' && pathParts.length >= 2) {
                clinicIdFromPath = pathParts[pathParts.length - 2];
            } else {
                clinicIdFromPath = pathParts[pathParts.length - 1];
            }
        }

        console.log("DEBUG: Extracted Clinic ID:", clinicIdFromPath);

        if (!clinicIdFromPath) {
            return json(400, { error: "Missing clinicId in URL path." });
        }

        // --- 1. FIND THE PROFILE ---
        const queryCommand = new QueryCommand({
            TableName: CLINIC_PROFILES_TABLE,
            KeyConditionExpression: "clinicId = :cid",
            ExpressionAttributeValues: { ":cid": clinicIdFromPath }
        });

        const queryResult = await ddbDoc.send(queryCommand);
        const existingProfile = queryResult.Items?.[0];

        if (!existingProfile) {
            return json(404, { error: "Clinic profile not found.", details: `No profile exists for clinicId: ${clinicIdFromPath}` });
        }

        const dbUserSub = existingProfile.userSub;

        // --- 2. AUTH CHECK ---
        const isRootUser = groups.includes("Root");
        if (loggedInUserSub !== dbUserSub && !isRootUser) {
            return json(403, { error: "Access denied." });
        }

        // --- 3. TRANSFORM & UPDATE ---
        
        // Handle Base64 Encoding
        let bodyString = event.body;
        if (event.isBase64Encoded && bodyString) {
            bodyString = Buffer.from(bodyString, 'base64').toString('utf-8');
        }

        console.log("📦 Body String to Parse:", bodyString);

        let requestBody;
        try {
            requestBody = JSON.parse(bodyString);
        } catch (e) {
            return json(400, { error: "Invalid JSON body format" });
        }

        const dynamoBody = transformBody(requestBody);

        const allowedFields = [
            "assisted_hygiene_available", "booking_out_period", "city", "clinic_name", "clinic_phone",
            "free_parking_available", "insurance_plans_accepted", "num_assistants", "num_doctors",
            "num_hygienists", "number_of_operatories", "parking_type", "practice_type",
            "primary_contact_first_name", "primary_contact_last_name", "primary_practice_area",
            "software_used", "state", "description", "website", "dental_association",
            "clinic_email", "zip_code", "address_line_1"
        ];

        const validUpdateFields: any = {};
        const updatedFields: string[] = [];

        allowedFields.forEach((field) => {
            if (dynamoBody.hasOwnProperty(field)) {
                validUpdateFields[field] = dynamoBody[field];
                updatedFields.push(field);
            }
        });
        
        if (updatedFields.length === 0) {
            return json(400, { 
                error: "No updateable fields provided. Check your JSON keys.",
                receivedKeys: Object.keys(requestBody), 
                allowedKeys: allowedFields
            });
        }

        let updateExpression = "SET ";
        const expressionAttributeNames: Record<string, string> = { "#updatedAt": "updatedAt" };
        const expressionAttributeValues: Record<string, any> = { ":updatedAt": new Date().toISOString() };
        
        updatedFields.forEach((field, index) => {
            const separator = index === 0 ? "" : ", ";
            updateExpression += `${separator}#${field} = :${field}`;
            expressionAttributeNames[`#${field}`] = field;
            expressionAttributeValues[`:${field}`] = validUpdateFields[field];
        });

        updateExpression += ", #updatedAt = :updatedAt";

        const updateCommand = new UpdateCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { 
                clinicId: clinicIdFromPath,
                userSub: dbUserSub 
            }, 
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        });

        const result = await ddbDoc.send(updateCommand);

        return json(200, {
            message: "Clinic profile updated successfully",
            profile: result.Attributes, 
        });

    } catch (error: any) {
        console.error("❌ Error:", error);
        return json(500, { error: "Internal Server Error", details: error.message });
    }
};