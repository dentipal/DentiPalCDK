import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandInput,
    DeleteItemCommand,
    DeleteItemCommandInput,
    QueryCommand,
    QueryCommandInput,
    BatchWriteItemCommand,
    BatchWriteItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the structure for the DeleteRequest item used in BatchWriteItem
interface DeleteRequestItem {
    DeleteRequest: {
        Key: Record<string, AttributeValue>;
    };
}

// Define a shared structure for DynamoDB items returned by Query/Scan commands.
// This resolves the implicit 'any' error (7006) in filter/forEach callbacks.
interface QueriedItem extends Record<string, AttributeValue | undefined> {
    jobId?: { S: string };
    applicationId?: { S: string };
    professionalUserSub?: { S: string };
    invitationStatus?: { S: string };
    applicationStatus?: { S: string };
    negotiationId?: { S: string };
    // Include other attributes as needed
}

// Define the job structure for the initial fetch
interface JobItem extends QueriedItem {
    clinicUserSub: { S: string };
    job_type: { S: string };
    status?: { S: string };
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication Check (Get userSub from authorizer claims)
        const userSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
        if (!userSub) {
            return json(401, { error: 'Unauthorized' });
        }

        // 2. HTTP Method Check
        if (method !== 'DELETE') {
            return json(405, { error: 'Method not allowed. Only DELETE is supported.' });
        }

        // 3. Extract job ID from path parameters
        const jobId: string | undefined = event.pathParameters?.jobId;
        if (!jobId) {
            return json(400, { error: 'Job ID is required' });
        }

        // 4. Get existing job to verify ownership and status
        const getCommandInput: GetItemCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: { jobId: { S: jobId } }
        };
        const existingJob = await dynamodb.send(new GetItemCommand(getCommandInput));

        if (!existingJob.Item) {
            return json(404, { error: 'Job not found' });
        }
        
        // Ensure Item properties exist before accessing
        const item = existingJob.Item as JobItem;
        if (!item.clinicUserSub?.S || !item.job_type?.S) {
             return json(500, { error: 'Job data is incomplete in the database.' });
        }

        const clinicUserSub: string = item.clinicUserSub.S;
        const currentStatus: string = item.status?.S || 'active';
        const jobType: string = item.job_type.S;

        // 5. Security check: Only clinic owner can delete their jobs
        if (userSub !== clinicUserSub) {
            return json(403, { error: 'Access denied - you can only delete your own jobs' });
        }

        // 6. Business logic: Prevent deletion of jobs in certain statuses
        if (currentStatus === 'scheduled') {
            return json(400, {
                error: 'Cannot delete scheduled jobs. Please complete or cancel the job first.'
            });
        }
        if (currentStatus === 'action_needed') {
            return json(400, {
                error: 'Cannot delete jobs with pending negotiations. Please resolve negotiations first.'
            });
        }

        const itemsToDelete: DeleteRequestItem[] = [];
        let hasActiveApplicationsOrInvitations: boolean = false;

        // 7. Check for active applications
        try {
            const applicationsQueryInput: QueryCommandInput = {
                TableName: process.env.JOB_APPLICATIONS_TABLE,
                IndexName: 'JobIndex', // Assumed GSI
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: { ':jobId': { S: jobId } }
            };
            const applications = await dynamodb.send(new QueryCommand(applicationsQueryInput));

            if (applications.Items) {
                const activeApplications = applications.Items.filter((item: QueriedItem) => {
                    const status = item.applicationStatus?.S || 'pending';
                    return !['withdrawn', 'rejected'].includes(status);
                });
                
                if (activeApplications.length > 0) {
                    hasActiveApplicationsOrInvitations = true;
                    return json(400, {
                        error: `Cannot delete job with ${activeApplications.length} active application(s). Please handle applications first.`
                    });
                }
                // Collect applications for potential forced cleanup later
                applications.Items.forEach((item: QueriedItem) => {
                    if (item.jobId?.S && item.applicationId?.S) {
                        itemsToDelete.push({ DeleteRequest: { Key: { jobId: { S: item.jobId.S }, applicationId: { S: item.applicationId.S } } } });
                    }
                });
            }
        } catch (error) {
            console.log('Error checking applications (might be missing GSI or table):', (error as Error).message);
            // Continue with deletion even if applications table has issues
        }

        // 8. Check for active invitations
        try {
            const invitationsQueryInput: QueryCommandInput = {
                TableName: process.env.JOB_INVITATIONS_TABLE,
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: { ':jobId': { S: jobId } }
            };
            const invitations = await dynamodb.send(new QueryCommand(invitationsQueryInput));

            if (invitations.Items) {
                const activeInvitations = invitations.Items.filter((item: QueriedItem) => {
                    const status = item.invitationStatus?.S || 'pending';
                    return !['declined', 'withdrawn'].includes(status);
                });
                
                if (activeInvitations.length > 0) {
                    hasActiveApplicationsOrInvitations = true;
                    return json(400, {
                        error: `Cannot delete job with ${activeInvitations.length} active invitation(s). Please cancel invitations first.`
                    });
                }
                // Collect invitations for potential forced cleanup later
                invitations.Items.forEach((item: QueriedItem) => {
                    if (item.jobId?.S && item.professionalUserSub?.S) {
                        itemsToDelete.push({
                            DeleteRequest: {
                                Key: { jobId: { S: item.jobId.S }, professionalUserSub: { S: item.professionalUserSub.S } }
                            }
                        });
                    }
                });
            }
        } catch (error) {
            console.log('Error checking invitations:', (error as Error).message);
            // Continue with deletion
        }

        // 9. Check for 'completed' status without force delete
        const forceDelete: boolean = event.queryStringParameters?.force === 'true';

        if (!forceDelete && currentStatus === 'completed') {
            return json(400, {
                error: 'Cannot delete completed jobs. Use ?force=true to force deletion (this will remove all related data).',
                warning: 'Forced deletion will permanently remove all job history, applications, and related data.'
            });
        }
        
        // 10. Perform cleanup of negotiations if force delete is requested and applications were retrieved
        if (forceDelete) {
            // Re-query applications (since we filtered and returned previously, we need to ensure we have all items)
            // If the original application query was successful (itemsToDelete is populated), we proceed.
            try {
                // Iterate over collected applications to find related negotiations
                // Filter itemsToDelete to get only application keys (jobId and applicationId)
                for (const app of itemsToDelete.filter(i => i.DeleteRequest.Key.applicationId && i.DeleteRequest.Key.jobId)) {
                    const appId = app.DeleteRequest.Key.applicationId.S;
                    
                    if (!appId) continue;

                    const negotiationsQueryInput: QueryCommandInput = {
                        TableName: process.env.JOB_NEGOTIATIONS_TABLE,
                        // This assumes JOB_NEGOTIATIONS_TABLE has applicationId as a GSI or PK
                        KeyConditionExpression: 'applicationId = :appId',
                        ExpressionAttributeValues: { ':appId': { S: appId } }
                    };
                    const negotiations = await dynamodb.send(new QueryCommand(negotiationsQueryInput));
                    
                    if (negotiations.Items) {
                        negotiations.Items.forEach((item: QueriedItem) => {
                            if (item.applicationId?.S && item.negotiationId?.S) {
                                itemsToDelete.push({
                                    DeleteRequest: {
                                        Key: { applicationId: { S: item.applicationId.S }, negotiationId: { S: item.negotiationId.S } }
                                    }
                                });
                            }
                        });
                    }
                }
            } catch (error) {
                console.log('Error collecting related negotiations for cleanup:', (error as Error).message);
            }
        }

        // 11. Delete the job posting
        const deleteCommandInput: DeleteItemCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: { jobId: { S: jobId } },
            ReturnValues: 'ALL_OLD'
        };
        const deletedJob = await dynamodb.send(new DeleteItemCommand(deleteCommandInput));

        // 12. Perform batch cleanup if there are related items to delete
        const relatedItemsDeletedCount = itemsToDelete.length;
        if (relatedItemsDeletedCount > 0) {
            const batchSize = 25;
            
            // Loop through all collected items in batches
            for (let i = 0; i < relatedItemsDeletedCount; i += batchSize) {
                const batch = itemsToDelete.slice(i, i + batchSize);
                
                // Group by table name for BatchWriteItem
                const requestItems: Record<string, DeleteRequestItem[]> = {};
                batch.forEach(item => {
                    // Determine table based on key structure (using attribute name check, as in original JS)
                    const keys = Object.keys(item.DeleteRequest.Key);
                    let tableName: string | undefined;

                    if (keys.includes('applicationId') && keys.includes('negotiationId')) {
                        tableName = process.env.JOB_NEGOTIATIONS_TABLE;
                    } else if (keys.includes('jobId') && keys.includes('applicationId')) {
                        tableName = process.env.JOB_APPLICATIONS_TABLE;
                    } else if (keys.includes('jobId') && keys.includes('professionalUserSub')) {
                        tableName = process.env.JOB_INVITATIONS_TABLE;
                    }
                    
                    if (tableName) {
                        if (!requestItems[tableName]) {
                            requestItems[tableName] = [];
                        }
                        requestItems[tableName].push(item); 
                    }
                });
                
                if (Object.keys(requestItems).length > 0) {
                    const batchDeleteCommandInput: BatchWriteItemCommandInput = {
                        RequestItems: requestItems,
                    };
                    try {
                        await dynamodb.send(new BatchWriteItemCommand(batchDeleteCommandInput));
                    } catch (error) {
                        console.error('Error in batch cleanup:', (error as Error).message);
                        // Don't fail the primary job deletion if cleanup fails
                    }
                }
            }
        }

        // 13. Final Response
        return json(200, {
            message: 'Job deleted successfully',
            jobId,
            deletedAt: new Date().toISOString(),
            jobType,
            forceDelete,
            cleanupPerformed: relatedItemsDeletedCount > 0,
            relatedItemsDeleted: relatedItemsDeletedCount,
            deletedJob: deletedJob.Attributes // Attributes of the job before deletion
        });

    } catch (error) {
        const err = error as Error;
        console.error('Error deleting job posting:', err);
        return json(500, { error: 'Internal server error', details: err.message });
    }
};

exports.handler = handler;