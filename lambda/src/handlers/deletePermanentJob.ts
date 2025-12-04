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

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// Allowed groups
const ALLOWED_GROUPS = new Set(["Root", "ClinicAdmin", "ClinicManager"]);

// Helper
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication & Authorization
        let userSub: string;
        let userGroups: string[] = [];
        
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }

        const normalizedGroups = userGroups.map(g => g.toLowerCase());
        const isAllowed = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));

        if (!isAllowed) {
            return json(403, { error: "You do not have permission to delete this job." });
        }

        // 2. Extract Job ID
        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
             const pathParts = event.pathParameters.proxy.split("/");
             jobId = pathParts[pathParts.length - 1]; 
        }

        if (!jobId) {
            return json(400, { error: "jobId is required in path parameters" });
        }

        // 3. Verify Job Existence & Ownership
        // Assuming Schema: PK=clinicUserSub, SK=jobId based on previous files
        const getJobCommand = new GetCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: userSub, 
                jobId: jobId,           
            },
        });
        
        const jobResponse = await ddbDoc.send(getJobCommand);
        const job = jobResponse.Item;

        if (!job) {
            return json(404, { error: "Permanent job not found or access denied" });
        }

        // 4. Verify Type
        if (job.job_type !== "permanent") {
            return json(400, { error: "This is not a permanent job. Use the appropriate endpoint for this job type." });
        }

        // 5. Check Active Applications
        const applicationsCommand = new QueryCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            // Assuming GSI 'JobIndex' exists where PK=jobId
            IndexName: 'JobIndex', 
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":pending": "pending",
                ":accepted": "accepted",
                ":negotiating": "negotiating",
            },
        });
        
        const appsResponse = await ddbDoc.send(applicationsCommand);
        const activeApplications = appsResponse.Items || [];

        // 6. Cancel Active Applications
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications. Updating status.`);
            
            const updatePromises = activeApplications.map(async (application) => {
                const applicationId = application.applicationId;
                // Assuming standard keys; adjust if your table schema differs
                // Usually PK: jobId, SK: professionalUserSub OR PK: applicationId
                if (!applicationId) return;

                try {
                    const updateKey: Record<string, any> = {};
                    
                    if (application.jobId && application.professionalUserSub) {
                         updateKey.jobId = application.jobId;
                         updateKey.professionalUserSub = application.professionalUserSub;
                    } else if (application.applicationId) {
                         updateKey.applicationId = application.applicationId;
                    }

                    if (Object.keys(updateKey).length === 0) return;

                    const updateCommand = new UpdateCommand({
                        TableName: JOB_APPLICATIONS_TABLE,
                        Key: updateKey,
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": "job_cancelled",
                            ":updatedAt": new Date().toISOString(),
                        },
                    });
                    await ddbDoc.send(updateCommand);
                } catch (updateError) {
                    console.warn(`Failed to update application ${applicationId}:`, updateError);
                }
            });
            await Promise.all(updatePromises);
        }

        // 7. Delete Job
        const deleteCommand = new DeleteCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: userSub,
                jobId: jobId,
            },
        });
        await ddbDoc.send(deleteCommand);

        // 8. Response
        return json(200, {
            message: "Permanent job deleted successfully",
            jobId,
            affectedApplications: activeApplications.length,
            applicationHandling: activeApplications.length > 0
                ? "Active applications have been marked as 'job_cancelled'"
                : "No active applications were affected",
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting permanent job:", err);
        return json(500, {
            error: "Failed to delete permanent job. Please try again.",
            details: err.message,
        });
    }
};