import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    AttributeValue,
    GetItemCommandOutput,
    QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming 'utils' is a local file with a 'validateToken' function
import { validateToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Configuration and Initialization ---

// DynamoDB client initialization
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Allowed groups for deletion
const ALLOWED_GROUPS = ["root", "clinicadmin", "clinicmanager"] as const;
type AllowedGroup = typeof ALLOWED_GROUPS[number];
const ALLOWED_GROUPS_SET = new Set<AllowedGroup>(ALLOWED_GROUPS);


// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const MULTI_DAY_JOB_TYPE = "multi_day_consulting";

// --- Helper Types for DynamoDB Item Structure ---

// Exporting the interface is good practice
export interface JobPostItem { 
    clinicUserSub: { S: string };
    jobId: { S: string };
    job_type?: { S: string };
    // Add other relevant attributes as needed
}

// --- Lambda Handler ---

/**
 * Handles the deletion of a multi-day consulting job and updates any active applications.
 * @param event The API Gateway Proxy event.
 * @returns The API Gateway Proxy result.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1) Validate token and get userSub
        const userSub = await validateToken(event);
        console.log("Authenticated userSub:", userSub);

        // 2) Check groups for authorization
        const groupsClaim: string =
            event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";
        
        const groups: string[] = groupsClaim
            .split(",")
            .map(g => g.toLowerCase().trim())
            .filter(Boolean);
        console.log("User groups:", groups);

        // The assertion (g as AllowedGroup) is correct in TypeScript
        const isAllowed = groups.some(g => ALLOWED_GROUPS_SET.has(g as AllowedGroup));

        if (!isAllowed) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { requiredGroups: ALLOWED_GROUPS, userGroups: groups },
                timestamp: new Date().toISOString()
            });
        }

        // 3) Extract jobId from proxy path
        const pathParts = event.pathParameters?.proxy?.split("/") || [];
        const jobId = pathParts[2] || pathParts[pathParts.length - 1]; 
        
        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job ID is required",
                details: { pathFormat: "/jobs/multi_day_consulting/{jobId}" },
                timestamp: new Date().toISOString()
            });
        }

        // 4) Verify the job exists and belongs to the clinic 
        const getJobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });
        const jobResponse: GetItemCommandOutput = await dynamodb.send(getJobCommand);

        if (!jobResponse.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Multi-day consulting job not found",
                details: { jobId: jobId },
                timestamp: new Date().toISOString()
            });
        }

        // Asserting the structure for safe access
        const job = jobResponse.Item as unknown as JobPostItem;

        // 5) Ensure it's a multi_day_consulting job
        if (job.job_type?.S !== MULTI_DAY_JOB_TYPE) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid job type",
                details: { expected: MULTI_DAY_JOB_TYPE, received: job.job_type?.S },
                timestamp: new Date().toISOString()
            });
        }

        // 6) Check for active applications
        const applicationsCommand = new QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":pending": { S: "pending" },
                ":accepted": { S: "accepted" },
                ":negotiating": { S: "negotiating" }
            }
        });
        const applicationsResponse: QueryCommandOutput = await dynamodb.send(applicationsCommand);
        const activeApplications: Record<string, AttributeValue>[] = applicationsResponse.Items || [];

        // 7) Update active applications to "job_cancelled"
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);
            for (const application of activeApplications) {
                const applicationId = application.applicationId?.S || "";
                
                if (!applicationId) {
                    console.warn("Skipping application with missing applicationId:", application);
                    continue;
                }
                
                try {
                    const updateCommand = new UpdateItemCommand({
                        TableName: process.env.JOB_APPLICATIONS_TABLE,
                        Key: {
                            jobId: { S: jobId }, 
                            applicationId: { S: applicationId }
                        },
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": { S: "job_cancelled" },
                            ":updatedAt": { S: new Date().toISOString() }
                        }
                    });
                    await dynamodb.send(updateCommand);
                } catch (updateError) {
                    // Type assertion is necessary for error handling
                    console.warn(`Failed to update application ${applicationId}:`, (updateError as Error).message);
                }
            }
        }

        // 8) Delete the job from the postings table
        const deleteJobCommand = new DeleteItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });
        await dynamodb.send(deleteJobCommand);

        // 9) Return success
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Multi-day consulting job deleted successfully",
            data: {
                jobId: jobId,
                affectedApplications: activeApplications.length,
                applicationHandling: activeApplications.length > 0
                    ? "Active applications have been marked as 'job_cancelled'"
                    : "No active applications were affected"
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        // Type assertion is necessary for error handling
        const errorMessage = (error as Error).message;
        console.error("Error deleting multi-day consulting job:", error);
        
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete multi-day consulting job",
            details: { reason: errorMessage },
            timestamp: new Date().toISOString()
        });
    }
};