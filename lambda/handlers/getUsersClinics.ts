import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult
} from "aws-lambda";

import {
    DynamoDBClient,
    ScanCommand,
    ScanCommandInput
} from "@aws-sdk/client-dynamodb";

import { validateToken, isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    try {
        const userSub = validateToken(event);

        const groupsString =
            event.requestContext.authorizer?.claims?.["cognito:groups"] || "";
        const groups: string[] = groupsString ? groupsString.split(",") : [];

        const queryParams = event.queryStringParameters || {};

        const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
        const state = queryParams.state || undefined;
        const city = queryParams.city || undefined;
        const name = queryParams.name || undefined;

        const filterExpressions: string[] = [];
        const expressionAttributeValues: Record<string, { S: string }> = {};
        const expressionAttributeNames: Record<string, string> = {};

        if (state) {
            filterExpressions.push("contains(address, :state)");
            expressionAttributeValues[":state"] = { S: state };
        }

        if (city) {
            filterExpressions.push("contains(address, :city)");
            expressionAttributeValues[":city"] = { S: city };
        }

        if (name) {
            filterExpressions.push("contains(#name, :name)");
            expressionAttributeValues[":name"] = { S: name };
            expressionAttributeNames["#name"] = "name";
        }

        const scanCommand: ScanCommandInput = {
            TableName: process.env.CLINICS_TABLE,
            Limit: limit
        };

        if (filterExpressions.length > 0) {
            scanCommand.FilterExpression = filterExpressions.join(" AND ");
            scanCommand.ExpressionAttributeValues = expressionAttributeValues;

            if (Object.keys(expressionAttributeNames).length > 0) {
                scanCommand.ExpressionAttributeNames = expressionAttributeNames;
            }
        }

        const response = await dynamoClient.send(new ScanCommand(scanCommand));

        if (!response.Items || response.Items.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    status: "success",
                    clinics: [],
                    totalCount: 0,
                    message: "No clinics found"
                })
            };
        }

        console.log(
            "🔍 Raw items from DynamoDB:",
            JSON.stringify(response.Items, null, 2)
        );

        const clinics = response.Items.map((item: any) => {
            const createdBy = item.createdBy?.S || null;
            const associatedUsersRaw = item.AssociatedUsers?.L || [];
            const associatedUsers = associatedUsersRaw.map((u: any) => u.S);

            return {
                clinicId: item.clinicId?.S || "",
                name: item.name?.S || "",
                addressLine1: item.addressLine1?.S || "",
                addressLine2: item.addressLine2?.S || "",
                addressLine3: item.addressLine3?.S || "",
                city: item.city?.S || "",
                state: item.state?.S || "",
                pincode: item.pincode?.S || "",
                createdAt: item.createdAt?.S || "",
                updatedAt: item.updatedAt?.S || "",
                createdBy,
                associatedUsers
            };
        });

        let accessibleClinics = clinics;

        if (!isRoot(groups)) {
            accessibleClinics = clinics.filter(
                clinic =>
                    clinic.createdBy === userSub ||
                    clinic.associatedUsers.includes(userSub)
            );

            console.log(
                `🔒 Non-root user: Filtering clinics for associated user ${userSub}`
            );
        } else {
            console.log("✅ Root user: Accessing all clinics");
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                clinics: accessibleClinics,
                totalCount: accessibleClinics.length,
                filters: {
                    state: state || null,
                    city: city || null,
                    name: name || null,
                    limit
                },
                currentUser: {
                    userSub,
                    isRoot: isRoot(groups),
                    groups
                },
                message: `Retrieved ${accessibleClinics.length} clinic(s)`
            })
        };
    } catch (error: any) {
        console.error("❌ Error retrieving clinics:", error);

        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Failed to retrieve clinics. Please try again.",
                details: error.message
            })
        };
    }
};
