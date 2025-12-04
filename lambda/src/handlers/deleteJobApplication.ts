import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    ScanCommand,
    DeleteItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { extractUserFromBearerToken } from "./utils"; // Assumed dependency

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Interface for the DynamoDB Item structure we expect from the Scan result
interface ApplicationItem {
    jobId?: { S: string };
    professionalUserSub?: { S: string };
    applicationId?: { S: string };
    applicationStatus?: { S: string };
    // Add other fields as necessary, though these are the critical ones for this handler
    [key: string]: AttributeValue | undefined;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });



// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    try {
        // 1. Handle CORS preflight
        if (method === "OPTIONS") {
            // ✅ Uses imported headers
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // 2. Authenticate professional user
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // 3. Extract applicationId from the proxy path (e.g. /applications/abc-123)
        // event.pathParameters.proxy captures the remainder of the path after the resource definition
        const proxyPath = event.pathParameters?.proxy || "";
        const applicationId = proxyPath.split("/").pop();

        if (!applicationId) {
            console.warn("[VALIDATION] Missing applicationId in path parameters.");
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Application ID is required",
                details: { pathFormat: "/applications/{applicationId}" },
                timestamp: new Date().toISOString()
            });
        }

        // 4. Find the application by scanning (preserving inefficient original logic)
        const findApplicationCommand = new ScanCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE, // Assumed ENV var
            FilterExpression: "applicationId = :applicationId",
            ExpressionAttributeValues: {
                ":applicationId": { S: applicationId }
            }
        });

        console.log(`[DB] Scanning ${process.env.JOB_APPLICATIONS_TABLE} for applicationId: ${applicationId}`);
        const findResponse = await dynamodb.send(findApplicationCommand);

        if (!findResponse.Items || findResponse.Items.length === 0) {
            console.warn(`[DB] Application not found: ${applicationId}`);
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Job application not found",
                details: { applicationId: applicationId },
                timestamp: new Date().toISOString()
            });
        }

        const applicationFound = findResponse.Items[0] as ApplicationItem;
        const professionalUserSubFound = applicationFound.professionalUserSub?.S;
        const jobIdFound = applicationFound.jobId?.S;

        // 5. Ensure the application belongs to the requesting user
        if (professionalUserSubFound !== userSub) {
            console.warn(`[AUTH] User ${userSub} attempted to delete application belonging to ${professionalUserSubFound}`);
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { reason: "Can only delete own applications" },
                timestamp: new Date().toISOString()
            });
        }

        // 6. Prevent withdrawal of accepted jobs
        const currentStatus = applicationFound.applicationStatus?.S || "pending";
        if (currentStatus === "accepted") {
            console.warn(`[VALIDATION] Cannot withdraw accepted application ${applicationId}`);
            return json(409, {
                error: "Conflict",
                statusCode: 409,
                message: "Cannot withdraw accepted application",
                details: { currentStatus: currentStatus, suggestion: "Contact clinic directly" },
                timestamp: new Date().toISOString()
            });
        }

        // We need both PK (jobId) and SK (professionalUserSub) for DeleteItem
        if (!jobIdFound) {
            console.error(`[DATA_ERROR] Application item ${applicationId} is missing jobId.`);
            return json(500, {
                error: "Internal Server Error",
                statusCode: 500,
                message: "Application record incomplete",
                details: { missingField: "jobId" },
                timestamp: new Date().toISOString()
            });
        }


        // 7. Proceed with deletion using composite key and ConditionExpression for safety
        const deleteCommand = new DeleteItemCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE, // Assumed ENV var
            Key: {
                jobId: { S: jobIdFound },
                professionalUserSub: { S: userSub }
            },
            // The condition ensures we only delete the record corresponding to the applicationId found via scan
            ConditionExpression: "applicationId = :applicationId",
            ExpressionAttributeValues: {
                ":applicationId": { S: applicationId }
            }
        });

        console.log(`[DB] Deleting job application ${applicationId} for user ${userSub}`);
        await dynamodb.send(deleteCommand);

        // 8. Success Response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Job application withdrawn successfully",
            data: {
                applicationId: applicationId,
                jobId: jobIdFound,
                withdrawnAt: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error deleting job application:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Job application not found or already deleted",
                details: { reason: "Conditional check failed" },
                timestamp: new Date().toISOString()
            });
        }

        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to withdraw job application",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};