import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    ScanCommand,
    DeleteItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils"; // Assumed dependency

// --- Type Definitions ---

// Type for CORS headers
interface CorsHeaders {
    [header: string]: string;
}

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

// CORS headers
const CORS: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
};

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    try {
        // 1. Handle CORS preflight
        if (method === "OPTIONS") {
            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({ message: "CORS preflight OK" })
            };
        }

        // 2. Authenticate professional user
        const userSub: string = await validateToken(event);

        // 3. Extract applicationId from the proxy path (e.g. /applications/abc-123)
        // event.pathParameters.proxy captures the remainder of the path after the resource definition
        const proxyPath = event.pathParameters?.proxy || "";
        const applicationId = proxyPath.split("/").pop();

        if (!applicationId) {
            console.warn("[VALIDATION] Missing applicationId in path parameters.");
            return {
                statusCode: 400,
                headers: CORS,
                body: JSON.stringify({
                    error: "applicationId is required in path parameters"
                })
            };
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
            return {
                statusCode: 404,
                headers: CORS,
                body: JSON.stringify({
                    error: "Job application not found"
                })
            };
        }

        const applicationFound = findResponse.Items[0] as ApplicationItem;
        const professionalUserSubFound = applicationFound.professionalUserSub?.S;
        const jobIdFound = applicationFound.jobId?.S;

        // 5. Ensure the application belongs to the requesting user
        if (professionalUserSubFound !== userSub) {
            console.warn(`[AUTH] User ${userSub} attempted to delete application belonging to ${professionalUserSubFound}`);
            return {
                statusCode: 403,
                headers: CORS,
                body: JSON.stringify({
                    error: "You can only delete your own job applications"
                })
            };
        }

        // 6. Prevent withdrawal of accepted jobs
        const currentStatus = applicationFound.applicationStatus?.S || "pending";
        if (currentStatus === "accepted") {
            console.warn(`[VALIDATION] Cannot withdraw accepted application ${applicationId}`);
            return {
                statusCode: 400,
                headers: CORS,
                body: JSON.stringify({
                    error: "Cannot withdraw an accepted job application. Please contact the clinic directly."
                })
            };
        }

        // We need both PK (jobId) and SK (professionalUserSub) for DeleteItem
        if (!jobIdFound) {
            console.error(`[DATA_ERROR] Application item ${applicationId} is missing jobId.`);
            return {
                statusCode: 500,
                headers: CORS,
                body: JSON.stringify({
                    error: "Internal data error: Application record is incomplete."
                })
            };
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
        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                message: "Job application withdrawn successfully",
                applicationId,
                jobId: jobIdFound,
                withdrawnAt: new Date().toISOString()
            })
        };
    } catch (error) {
        const err = error as Error;
        console.error("Error deleting job application:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 404,
                headers: CORS,
                body: JSON.stringify({
                    error: "Job application not found or already deleted"
                })
            };
        }

        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({
                error: "Failed to withdraw job application. Please try again.",
                details: err.message
            })
        };
    }
};