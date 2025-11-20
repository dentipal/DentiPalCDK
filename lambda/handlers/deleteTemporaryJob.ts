import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    AttributeValue,
    GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils"; 

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Define CORS headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
};

/**
 * AWS Lambda handler to delete a temporary job posting and update its active applications.
 * @param event The API Gateway event object.
 * @returns A APIGatewayProxyResult object.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    // Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Validate Token and Extract User Sub
        // We cast event to 'any' to ensure compatibility if validateToken expects specific properties not strictly in ProxyEvent
        const userSub: string = await validateToken(event as any);
        console.log("userSub:", userSub);

        // 2. Extract jobId from Path
        // Supports direct path parameter {jobId} or proxy path /jobs/temporary/{jobId}
        let jobId = event.pathParameters?.jobId;
        
        if (!jobId && event.pathParameters?.proxy) {
             const pathParts: string[] = event.pathParameters.proxy.split("/");
             // Expected path: /jobs/temporary/{jobId} -> parts[2]
             jobId = pathParts[pathParts.length - 1]; 
        }

        console.log("Extracted jobId:", jobId);

        if (!jobId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "jobId is required in path parameters",
                }),
            };
        }

        // 3. Verify Job Existence and Ownership
        const getJobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                // Assuming Schema: PK=clinicUserSub, SK=jobId based on previous context
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
            },
        });

        const jobResponse: GetItemCommandOutput = await dynamodb.send(getJobCommand);
        const job = jobResponse.Item;

        console.log("jobResponse:", jobResponse);

        if (!job) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Temporary job not found or access denied",
                }),
            };
        }

        // 4. Verify Job Type is 'temporary'
        if (job.job_type?.S !== 'temporary') {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type.",
                }),
            };
        }

        // 5. Check for Active Applications
        const applicationsCommand = new QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            // Assuming 'JobIndex' GSI exists where PK=jobId, or jobId is the PK of the table
            // If jobId is NOT the partition key of the table, you MUST specify IndexName: 'JobIndex'
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

        console.log("activeApplications:", activeApplications);

        // 6. Update Active Applications (Concurrency for performance)
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications for job ${jobId}. Updating their status.`);
            
            // Use Promise.all to run all updates concurrently
            await Promise.all(activeApplications.map(async (application) => {
                const applicationId = application.applicationId?.S;
                const professionalUserSub = application.professionalUserSub?.S;

                if (!applicationId) {
                    console.warn("Application item missing applicationId field, skipping update:", application);
                    return;
                }

                try {
                    // Determine the Primary Key for the update
                    // Usually it's Composite: (jobId, professionalUserSub) OR just (applicationId)
                    // Adjust 'Key' below to match your actual JOB_APPLICATIONS_TABLE schema
                    const updateKey: Record<string, AttributeValue> = {};
                    
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

                    await dynamodb.send(new UpdateItemCommand({
                        TableName: process.env.JOB_APPLICATIONS_TABLE,
                        Key: updateKey,
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": { S: "job_cancelled" },
                            ":updatedAt": { S: new Date().toISOString() },
                        },
                    }));
                }
                catch (updateError) {
                    // Log warning but allow the job deletion to proceed
                    console.warn(`Failed to update application ${applicationId}:`, updateError);
                }
            }));
        }

        // 7. Delete the Job Posting
        const deleteCommand = new DeleteItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
            },
        });
        await dynamodb.send(deleteCommand);

        // 8. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Temporary job deleted successfully",
                jobId,
                affectedApplications: activeApplications.length,
                applicationHandling: activeApplications.length > 0 ?
                    "Active applications have been marked as 'job_cancelled'" :
                    "No active applications were affected",
            }),
        };
    }
    catch (error) {
        // 9. Error Handling
        const err = error as Error;
        console.error("Error deleting temporary job:", err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Failed to delete temporary job. Please try again.",
                details: err.message,
            }),
        };
    }
};