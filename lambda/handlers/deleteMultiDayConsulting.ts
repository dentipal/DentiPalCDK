import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
    DynamoDBDocumentClient, 
    GetCommand, 
    QueryCommand, 
    UpdateCommand, 
    DeleteCommand 
} from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils"; 
import { CORS_HEADERS } from "./corsHeaders";

// --- Configuration and Initialization ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

const MULTI_DAY_JOB_TYPE = "multi_day_consulting";

// Allowed groups for deletion
const ALLOWED_GROUPS = new Set(["Root", "ClinicAdmin", "ClinicManager"]);

// --- Helpers ---

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, "");

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    if (method !== 'DELETE') {
        return json(405, { error: "Method not allowed" });
    }

    try {
        // 2. Authentication (Access Token)
        let userSub: string;
        let userGroups: string[] = [];

        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            return json(401, { 
                error: "Unauthorized", 
                message: authError.message || "Invalid access token" 
            });
        }

        // 3. Group Authorization
        const normalizedGroups = userGroups.map(normalizeGroup);
        const isAllowed = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));

        if (!isAllowed) {
            return json(403, {
                error: "Forbidden",
                message: "Access denied",
                details: { requiredGroups: Array.from(ALLOWED_GROUPS), userGroups }
            });
        }

        // 4. Extract jobId
        const pathParts = event.path?.split("/").filter(Boolean) || [];
        // Robustly find ID: usually last part or specific index depending on routing
        const jobId = event.pathParameters?.jobId || pathParts[pathParts.length - 1]; 
        
        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                message: "Job ID is required",
                details: { pathFormat: "/jobs/multi_day_consulting/{jobId}" }
            });
        }

        // 5. Verify the job exists and belongs to the clinic
        const getJobCommand = new GetCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: userSub, // Primary Key
                jobId: jobId            // Sort Key
            }
        });
        const jobResponse = await ddbDoc.send(getJobCommand);

        if (!jobResponse.Item) {
            return json(404, {
                error: "Not Found",
                message: "Multi-day consulting job not found",
                details: { jobId }
            });
        }

        const job = jobResponse.Item;

        // 6. Ensure it's a multi_day_consulting job
        if (job.job_type !== MULTI_DAY_JOB_TYPE) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid job type for this operation",
                details: { expected: MULTI_DAY_JOB_TYPE, received: job.job_type }
            });
        }

        // 7. Check for active applications
        const applicationsCommand = new QueryCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":pending": "pending",
                ":accepted": "accepted",
                ":negotiating": "negotiating"
            }
        });

        const applicationsResponse = await ddbDoc.send(applicationsCommand);
        const activeApplications = applicationsResponse.Items || [];

        // 8. Update active applications to "job_cancelled"
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);
            
            const updatePromises = activeApplications.map(async (application) => {
                const applicationId = application.applicationId;
                const professionalUserSub = application.professionalUserSub; // Needed if it's part of the key

                if (!applicationId) return;

                // Assuming Schema: PK=jobId, SK=professionalUserSub (standard pattern for applications table)
                // Adjust Key structure if your table schema differs
                try {
                    const updateCommand = new UpdateCommand({
                        TableName: JOB_APPLICATIONS_TABLE,
                        Key: {
                            jobId: jobId, 
                            professionalUserSub: professionalUserSub 
                        },
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": "job_cancelled",
                            ":updatedAt": new Date().toISOString()
                        }
                    });
                    await ddbDoc.send(updateCommand);
                } catch (updateError) {
                    console.warn(`Failed to update application ${applicationId}:`, (updateError as Error).message);
                }
            });

            await Promise.all(updatePromises);
        }

        // 9. Delete the job from the postings table
        const deleteJobCommand = new DeleteCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: userSub,
                jobId: jobId
            }
        });
        await ddbDoc.send(deleteJobCommand);

        // 10. Return success
        return json(200, {
            status: "success",
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
        const err = error as Error;
        console.error("Error deleting multi-day consulting job:", err);
        
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to delete multi-day consulting job",
            details: { reason: err.message }
        });
    }
};