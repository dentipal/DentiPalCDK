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
        // 1. Authentication
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }

        // 2. Extract Job ID
        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
             const pathParts = event.pathParameters.proxy.split("/");
             jobId = pathParts[pathParts.length - 1]; 
        }

        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                message: "Job ID is required",
                details: { pathFormat: "/jobs/temporary/{jobId}" }
            });
        }

        // 3. Verify Job Existence & Ownership
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
            return json(404, {
                error: "Not Found",
                message: "Temporary job not found",
                details: { jobId: jobId }
            });
        }

        // 4. Verify Job Type
        if (job.job_type !== 'temporary') {
            return json(400, {
                error: "Bad Request",
                message: "Invalid job type",
                details: { expected: "temporary", received: job.job_type }
            });
        }

        // 5. Check for Active Applications
        const applicationsCommand = new QueryCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            // Assuming 'JobIndex' GSI exists where PK=jobId
            // IndexName: 'JobIndex',
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":pending": "pending",
                ":accepted": "accepted",
                ":negotiating": "negotiating",
            },
        });

        let appResponse;
        try {
            appResponse = await ddbDoc.send(applicationsCommand);
        } catch (error) {
            const err = error as any; // Explicitly cast 'error' to 'any'
            if (err instanceof Error) { // Narrowing 'err' to Error type
                if (err.name === "ValidationException" && err.message.includes("specified index")) {
                    console.error("The specified index 'JobIndex' does not exist on the table.");
                    return json(500, {
                        error: "Internal Server Error",
                        message: "The table does not have the specified index: JobIndex",
                        details: { reason: err.message }
                    });
                }
            }
            throw err; // Re-throw other errors
        }

        const activeApplications = appResponse.Items || [];

        // 6. Update Active Applications
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications. Updating status.`);
            
            await Promise.all(activeApplications.map(async (application) => {
                const applicationId = application.applicationId;
                const professionalUserSub = application.professionalUserSub;

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

                    await ddbDoc.send(new UpdateCommand({
                        TableName: JOB_APPLICATIONS_TABLE,
                        Key: updateKey,
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": "job_cancelled",
                            ":updatedAt": new Date().toISOString(),
                        },
                    }));
                }
                catch (updateError) {
                    console.warn(`Failed to update application ${applicationId}:`, updateError);
                }
            }));
        }

        // 7. Delete the Job
        const deleteCommand = new DeleteCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: userSub,
                jobId: jobId,
            },
        });
        await ddbDoc.send(deleteCommand);

        // 8. Success
        return json(200, {
            status: "success",
            message: "Temporary job deleted successfully",
            data: {
                jobId: jobId,
                affectedApplications: activeApplications.length,
                applicationHandling: activeApplications.length > 0 ?
                    "Active applications have been marked as 'job_cancelled'" :
                    "No active applications were affected"
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting temporary job:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to delete temporary job",
            details: { reason: err.message }
        });
    }
};