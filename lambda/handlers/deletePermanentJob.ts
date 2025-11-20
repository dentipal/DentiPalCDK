import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Interfaces and Type Definitions ---

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Allowed groups for job deletion
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

// ❌ REMOVED INLINE CORS DEFINITION
/*
// Define CORS headers for the response
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json"
};
*/

// --- Lambda Handler Function ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    // Handle Preflight
    if (method === "OPTIONS") {
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: ""
        };
    }

    try {
        // Step 1: Validate token and get userSub
        // We cast event to 'any' to ensure compatibility if validateToken expects specific properties
        const userSub: string = await validateToken(event as any);
        console.log("Authenticated userSub:", userSub);

        // Step 2: Extract Cognito groups and perform authorization
        const claims = event.requestContext?.authorizer?.claims || {};
        // Handle both array (HTTP API) and string (REST API) formats for groups
        const rawGroups = claims["cognito:groups"] || claims["groups"] || "";
        
        let groups: string[] = [];
        if (Array.isArray(rawGroups)) {
            groups = rawGroups.map(String).map(g => g.toLowerCase());
        } else if (typeof rawGroups === 'string') {
            groups = rawGroups.split(",").map(g => g.trim().toLowerCase()).filter(Boolean);
        }

        console.log("User groups:", groups);

        const isAllowed: boolean = groups.some(g => ALLOWED_GROUPS.has(g));

        if (!isAllowed) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "You do not have permission to delete this job.",
                }),
            };
        }

        // Step 3: Extract jobId from proxy path or pathParameters
        // Supports direct path parameter {jobId} or proxy path /jobs/permanent/{jobId}
        let jobId = event.pathParameters?.jobId;
        
        if (!jobId && event.pathParameters?.proxy) {
             const pathParts: string[] = event.pathParameters.proxy.split("/");
             // Expected path: /jobs/permanent/{jobId} -> parts[2]
             // Adjust index based on your actual API Gateway routing
             jobId = pathParts[pathParts.length - 1]; 
        }

        if (!jobId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "jobId is required in path parameters",
                }),
            };
        }

        // Step 4: Verify the job exists and belongs to the clinic (using clinicUserSub as Partition Key)
        const getJobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                // Assuming Schema: PK=clinicUserSub, SK=jobId OR just PK=jobId depending on your table.
                // Based on previous files (deleteJobPosting.ts), it seems PK=jobId. 
                // However, your code used clinicUserSub + jobId. I will stick to your code's logic 
                // but usually, GetItem requires the full primary key.
                // If your table uses ONLY jobId as PK, remove clinicUserSub from Key.
                // If your table is PK=clinicUserSub, SK=jobId, keep both.
                clinicUserSub: { S: userSub }, 
                jobId: { S: jobId },           
            },
        });
        
        // NOTE: If this GetItem fails with "The provided key element does not match the schema",
        // check if your table actually has a Composite Key or just a Partition Key (jobId).
        
        const jobResponse = await dynamodb.send(getJobCommand);

        if (!jobResponse.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "Permanent job not found or access denied",
                }),
            };
        }

        const job = jobResponse.Item;

        // Step 5: Verify it's a permanent job
        if (job.job_type?.S !== "permanent") {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "This is not a permanent job. Use the appropriate endpoint for this job type.",
                }),
            };
        }

        // Step 6: Check for active applications
        const applicationsCommand = new QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            // Assuming there is a GSI named 'JobIndex' where PK=jobId, otherwise this Query will fail
            // if jobId is not the main table PK.
            IndexName: 'JobIndex', 
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":pending": { S: "pending" },
                ":accepted": { S: "accepted" },
                ":negotiating": { S: "negotiating" },
            },
        });
        
        const applicationsResponse = await dynamodb.send(applicationsCommand);
        const activeApplications = applicationsResponse.Items || [];

        // Step 7: Update active applications to "job_cancelled"
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);

            const updatePromises = activeApplications.map(async (application) => {
                const applicationId = application.applicationId?.S;
                const professionalUserSub = application.professionalUserSub?.S; // Assuming composite key
                
                if (!applicationId) {
                    console.warn("Application found without applicationId, skipping update.");
                    return;
                }

                try {
                    // Assuming JOB_APPLICATIONS_TABLE Key structure. 
                    // Usually keys are (jobId, professionalUserSub) or (applicationId).
                    // Adjust Key below to match your actual table definition.
                    const updateKey: Record<string, AttributeValue> = {};
                    
                    // Heuristic based on typical patterns:
                    if (application.jobId?.S && application.professionalUserSub?.S) {
                         updateKey.jobId = { S: application.jobId.S };
                         updateKey.professionalUserSub = { S: application.professionalUserSub.S };
                    } else if (application.applicationId?.S) {
                         updateKey.applicationId = { S: application.applicationId.S };
                    }

                    if (Object.keys(updateKey).length === 0) {
                        console.warn("Could not determine Primary Key for application update", application);
                        return;
                    }

                    const updateItemCommand = new UpdateItemCommand({
                        TableName: process.env.JOB_APPLICATIONS_TABLE,
                        Key: updateKey,
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": { S: "job_cancelled" },
                            ":updatedAt": { S: new Date().toISOString() },
                        },
                    });
                    await dynamodb.send(updateItemCommand);
                } catch (updateError) {
                    console.warn(`Failed to update application ${applicationId}:`, updateError);
                }
            });
            // Run all update promises concurrently
            await Promise.all(updatePromises);
        }

        // Step 8: Delete the job
        const deleteCommand = new DeleteItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
            },
        });
        await dynamodb.send(deleteCommand);

        // Step 9: Return success
        const affectedApplicationsCount = activeApplications.length;
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                message: "Permanent job deleted successfully",
                jobId,
                affectedApplications: affectedApplicationsCount,
                applicationHandling: affectedApplicationsCount > 0
                    ? "Active applications have been marked as 'job_cancelled'"
                    : "No active applications were affected",
            }),
        };

    } catch (error) {
        console.error("Error deleting permanent job:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";

        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                error: "Failed to delete permanent job. Please try again.",
                details: errorMessage,
            }),
        };
    }
};

exports.handler = handler;