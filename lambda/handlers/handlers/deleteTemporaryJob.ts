// index.ts
import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    AttributeValue,
    GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";

// The utility function is assumed to be imported from './utils'.
// The actual type for the event is often APIGatewayProxyEventV2 or similar, 
// but we'll use a simplified interface for portability.
import { validateToken } from "./utils"; 

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Type Definitions ---

// Simplified interface for the Lambda event, focusing on necessary properties
interface LambdaEvent {
    pathParameters?: {
        proxy?: string;
    };
    [key: string]: any; // Allow other properties like 'headers'
}

// Interface for a DynamoDB Item with specific known keys and standard AttributeValue structure
interface DynamoDBItem {
    clinicUserSub?: AttributeValue;
    jobId?: AttributeValue;
    applicationId?: AttributeValue;
    job_type?: AttributeValue;
    applicationStatus?: AttributeValue;
    [key: string]: AttributeValue | undefined; // Allow for other properties
}

// Interface for the Lambda response
interface LambdaResponse {
    statusCode: number;
    headers: { [key: string]: string };
    body: string;
}

// Define CORS headers
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
};

/**
 * AWS Lambda handler to delete a temporary job posting and update its active applications.
 * * @param event The API Gateway event object.
 * @returns A LambdaResponse object.
 */
export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        // 1. Validate Token and Extract User Sub
        // Assumes validateToken returns the user's sub/ID (string) and throws on failure.
        const userSub: string = validateToken(event);
        console.log("userSub:", userSub);

        // 2. Extract jobId from Path
        // The path structure is assumed to be /jobs/temporary/{jobId} or similar
        const pathParts = event.pathParameters?.proxy?.split('/');
        const jobId = pathParts?.[2];

        console.log("Extracted jobId from path:", jobId);

        if (!jobId) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "jobId is required in path parameters",
                }),
            };
        }

        // 3. Verify Job Existence and Ownership
        const getJobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
            },
        });

        const jobResponse: GetItemCommandOutput = await dynamodb.send(getJobCommand);

        const job = jobResponse.Item as DynamoDBItem | undefined;

        console.log("jobResponse:", jobResponse);

        if (!job) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "Temporary job not found or access denied",
                }),
            };
        }

        // 4. Verify Job Type is 'temporary'
        if (job.job_type?.S !== 'temporary') {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type.",
                }),
            };
        }

        // 5. Check for Active Applications
        const applicationsCommand = new QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            // Note: FilterExpression is performed *after* the KeyConditionExpression (Query), 
            // potentially leading to high WCU consumption if the key returns many items.
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":pending": { S: "pending" },
                ":accepted": { S: "accepted" },
                ":negotiating": { S: "negotiating" },
            },
        });

        const applicationsResponse = await dynamodb.send(applicationsCommand);
        const activeApplications: DynamoDBItem[] = (applicationsResponse.Items as DynamoDBItem[] || []);

        console.log("activeApplications:", activeApplications);

        // 6. Update Active Applications (Concurrency for performance)
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications for job ${jobId}. Updating their status.`);
            
            // Use Promise.all to run all updates concurrently
            await Promise.all(activeApplications.map(async (application) => {
                const applicationId = application.applicationId?.S;
                if (!applicationId) {
                    console.warn("Application item missing applicationId field, skipping update:", application);
                    return;
                }

                try {
                    await dynamodb.send(new UpdateItemCommand({
                        TableName: process.env.JOB_APPLICATIONS_TABLE,
                        Key: {
                            jobId: { S: jobId },
                            applicationId: { S: applicationId },
                        },
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
            headers: corsHeaders,
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
    catch (error: any) {
        // 9. Error Handling
        console.error("Error deleting temporary job:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to delete temporary job. Please try again.",
                details: error.message,
            }),
        };
    }
};

// Export the handler for use by the Lambda runtime environment
// This line is for compatibility with Node.js modules environments
// It is equivalent to `export const handler = ...` in ES modules if transpiled correctly.
// exports.handler = handler;