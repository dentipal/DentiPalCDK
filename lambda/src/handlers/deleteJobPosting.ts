import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
    DynamoDBDocumentClient, 
    GetCommand, 
    QueryCommand, 
    DeleteCommand, 
    BatchWriteCommand,
    BatchWriteCommandInput
} from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, canWriteClinic } from "./utils";
import { corsHeaders } from "./corsHeaders";

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE || "DentiPal-JobInvitations";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

// Initialize Document Client
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- Helpers ---
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---
interface DeleteItem {
    TableName: string;
    Key: Record<string, any>;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    if (method !== 'DELETE') {
        return json(event, 405, { error: "Method Not Allowed", details: { allowedMethods: ["DELETE"] } });
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
            return json(event, 401, {
                error: "Unauthorized",
                message: authError.message || "Invalid access token"
            });
        }

        // 3. Extract job ID
        const jobId = event.pathParameters?.jobId;
        if (!jobId) {
            return json(event, 400, { error: "Bad Request", message: "Job ID is required" });
        }

        // 4. Get existing job to verify ownership and status
        const jobResult = await ddbDoc.send(new GetCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: { jobId: jobId }
        }));

        if (!jobResult.Item) {
            return json(event, 404, { error: "Not Found", message: "Job not found", details: { jobId } });
        }

        const job = jobResult.Item;
        const clinicUserSub = job.clinicUserSub;
        const currentStatus = job.status || 'active';

        // 5. Security check (existing: creator-only)
        if (userSub !== clinicUserSub) {
            return json(event, 403, {
                error: "Forbidden",
                message: "Only job owner can delete this job",
                details: { requiredOwner: clinicUserSub }
            });
        }

        // Additional role gate: ensure requester still holds a write role for this clinic.
        // Blocks a creator whose role was later downgraded to ClinicViewer.
        const jobClinicId = job.clinicId;
        if (jobClinicId && !(await canWriteClinic(userSub, userGroups, jobClinicId, "manageJobs"))) {
            return json(event, 403, {
                error: "Forbidden",
                message: "Your current role cannot delete jobs for this clinic"
            });
        }

        // 6. Business Logic Checks
        if (currentStatus === 'scheduled') {
            return json(event, 409, { 
                error: "Conflict", 
                message: "Cannot delete scheduled jobs",
                details: { suggestion: "Please complete or cancel the job first" } 
            });
        }
        if (currentStatus === 'action_needed') {
            return json(event, 409, { 
                error: "Conflict", 
                message: "Cannot delete jobs with pending negotiations",
                details: { suggestion: "Please resolve negotiations first" } 
            });
        }

        // 7. Collect items for deletion
        const itemsToDelete: DeleteItem[] = [];
        
        // Check Applications
        try {
            const appsResult = await ddbDoc.send(new QueryCommand({
                TableName: JOB_APPLICATIONS_TABLE,
                // Assuming GSI 'JobIndex' exists for querying by jobId
                IndexName: 'JobIndex', 
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: { ':jobId': jobId }
            }));

            const applications = appsResult.Items || [];
            
            // Filter active applications
            const activeApps = applications.filter(app => {
                const status = app.applicationStatus || 'pending';
                return !['withdrawn', 'rejected'].includes(status);
            });

            if (activeApps.length > 0) {
                return json(event, 400, { 
                    error: "Bad Request", 
                    message: `Cannot delete job with ${activeApps.length} active application(s). Please handle applications first.` 
                });
            }

            // Queue inactive applications for deletion
            applications.forEach(app => {
                if (app.jobId && app.applicationId) {
                    itemsToDelete.push({
                        TableName: JOB_APPLICATIONS_TABLE,
                        Key: { jobId: app.jobId, applicationId: app.applicationId }
                    });
                }
            });

        } catch (err) {
            console.warn('Error querying applications:', (err as Error).message);
            // Continue if query fails (e.g., missing index), but warn
        }

        // Check Invitations
        try {
            const invitesResult = await ddbDoc.send(new QueryCommand({
                TableName: JOB_INVITATIONS_TABLE,
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: { ':jobId': jobId }
            }));

            const invitations = invitesResult.Items || [];

            const activeInvites = invitations.filter(inv => {
                const status = inv.invitationStatus || 'pending';
                return !['declined', 'withdrawn'].includes(status);
            });

            if (activeInvites.length > 0) {
                return json(event, 400, { 
                    error: "Bad Request", 
                    message: `Cannot delete job with ${activeInvites.length} active invitation(s). Please cancel invitations first.` 
                });
            }

            invitations.forEach(inv => {
                if (inv.jobId && inv.professionalUserSub) {
                    itemsToDelete.push({
                        TableName: JOB_INVITATIONS_TABLE,
                        Key: { jobId: inv.jobId, professionalUserSub: inv.professionalUserSub }
                    });
                }
            });
        } catch (err) {
            console.warn('Error querying invitations:', (err as Error).message);
        }

        // 8. Handle 'completed' status with force param
        const forceDelete = event.queryStringParameters?.force === 'true';

        if (!forceDelete && currentStatus === 'completed') {
            return json(event, 400, { 
                error: "Bad Request", 
                message: 'Cannot delete completed jobs. Use ?force=true to force deletion.' 
            });
        }

        // 9. Cleanup Negotiations (Only if force delete and applications existed)
        if (forceDelete) {
            try {
                // Find applications we are about to delete
                const appItems = itemsToDelete.filter(i => i.TableName === JOB_APPLICATIONS_TABLE);
                
                for (const appItem of appItems) {
                    const appId = appItem.Key.applicationId;
                    if (!appId) continue;

                    const negoResult = await ddbDoc.send(new QueryCommand({
                        TableName: JOB_NEGOTIATIONS_TABLE,
                        KeyConditionExpression: 'applicationId = :appId',
                        ExpressionAttributeValues: { ':appId': appId }
                    }));

                    if (negoResult.Items) {
                        negoResult.Items.forEach(nego => {
                            if (nego.applicationId && nego.negotiationId) {
                                itemsToDelete.push({
                                    TableName: JOB_NEGOTIATIONS_TABLE,
                                    Key: { applicationId: nego.applicationId, negotiationId: nego.negotiationId }
                                });
                            }
                        });
                    }
                }
            } catch (err) {
                console.warn('Error collecting negotiations:', (err as Error).message);
            }
        }

        // 10. Delete the Job Posting
        await ddbDoc.send(new DeleteCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: { jobId: jobId }
        }));

        // 11. Batch Cleanup of Related Items
        if (itemsToDelete.length > 0) {
            const batchSize = 25;
            for (let i = 0; i < itemsToDelete.length; i += batchSize) {
                const batch = itemsToDelete.slice(i, i + batchSize);
                
                // Group by TableName
                const requestItems: Record<string, any[]> = {};
                batch.forEach(item => {
                    if (!requestItems[item.TableName]) {
                        requestItems[item.TableName] = [];
                    }
                    requestItems[item.TableName].push({
                        DeleteRequest: { Key: item.Key }
                    });
                });

                const batchWriteInput: BatchWriteCommandInput = { RequestItems: requestItems };
                try {
                    await ddbDoc.send(new BatchWriteCommand(batchWriteInput));
                } catch (err) {
                    console.error('Batch cleanup failed:', (err as Error).message);
                    // Don't fail main request
                }
            }
        }

        return json(event, 200, {
            status: "success",
            message: "Job deleted successfully",
            data: {
                jobId,
                deletedAt: new Date().toISOString(),
                forceDelete,
                relatedItemsDeleted: itemsToDelete.length
            }
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting job:", err);
        return json(event, 500, { 
            error: "Internal Server Error", 
            message: "Failed to delete job posting", 
            details: err.message 
        });
    }
};