"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        // Get user information from the event
        const userSub = event.requestContext.authorizer?.claims?.sub;
        if (!userSub) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }
        if (event.httpMethod !== 'DELETE') {
            return {
                statusCode: 405,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }
        // Extract job ID from path parameters
        const jobId = event.pathParameters?.jobId;
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Job ID is required' })
            };
        }
        // Get existing job to verify ownership and status
        const getCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            }
        });
        const existingJob = await dynamodb.send(getCommand);
        if (!existingJob.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }
        const clinicUserSub = existingJob.Item.clinicUserSub.S;
        const currentStatus = existingJob.Item.status?.S || 'open';
        const jobType = existingJob.Item.job_type.S;
        // Security check: Only clinic owner can delete their jobs
        if (userSub !== clinicUserSub) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Access denied - you can only delete your own jobs' })
            };
        }
        // Business logic: Prevent deletion of jobs with certain statuses
        if (currentStatus === 'scheduled') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: 'Cannot delete scheduled jobs. Please complete or cancel the job first.'
                })
            };
        }
        if (currentStatus === 'action_needed') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: 'Cannot delete jobs with pending negotiations. Please resolve negotiations first.'
                })
            };
        }
        // Check for active applications
        try {
            const applicationsQuery = new client_dynamodb_1.QueryCommand({
                TableName: process.env.JOB_APPLICATIONS_TABLE,
                IndexName: 'JobIndex', // Assuming there's a GSI on jobId
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: {
                    ':jobId': { S: jobId }
                }
            });
            const applications = await dynamodb.send(applicationsQuery);
            if (applications.Items && applications.Items.length > 0) {
                const activeApplications = applications.Items.filter(item => !item.status?.S || !['withdrawn', 'rejected'].includes(item.status.S));
                if (activeApplications.length > 0) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({
                            error: `Cannot delete job with ${activeApplications.length} active application(s). Please handle applications first.`
                        })
                    };
                }
            }
        }
        catch (error) {
            console.log('No applications found or error checking applications:', error);
            // Continue with deletion even if applications table doesn't exist or has issues
        }
        // Check for active invitations
        try {
            const invitationsQuery = new client_dynamodb_1.QueryCommand({
                TableName: process.env.JOB_INVITATIONS_TABLE,
                KeyConditionExpression: 'jobId = :jobId',
                ExpressionAttributeValues: {
                    ':jobId': { S: jobId }
                }
            });
            const invitations = await dynamodb.send(invitationsQuery);
            if (invitations.Items && invitations.Items.length > 0) {
                const activeInvitations = invitations.Items.filter(item => !item.invitationStatus?.S || !['declined'].includes(item.invitationStatus.S));
                if (activeInvitations.length > 0) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({
                            error: `Cannot delete job with ${activeInvitations.length} active invitation(s). Please cancel invitations first.`
                        })
                    };
                }
            }
        }
        catch (error) {
            console.log('No invitations found or error checking invitations:', error);
            // Continue with deletion
        }
        // Get query parameter to force delete
        const forceDelete = event.queryStringParameters?.force === 'true';
        if (!forceDelete && currentStatus === 'completed') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: 'Cannot delete completed jobs. Use ?force=true to force deletion (this will remove all related data).',
                    warning: 'Forced deletion will permanently remove all job history, applications, and related data.'
                })
            };
        }
        // Perform cleanup of related data if force delete
        const itemsToDelete = [];
        if (forceDelete) {
            // Collect all related items to delete in batch
            try {
                // Get applications to delete
                const applicationsQuery = new client_dynamodb_1.QueryCommand({
                    TableName: process.env.JOB_APPLICATIONS_TABLE,
                    IndexName: 'JobIndex',
                    KeyConditionExpression: 'jobId = :jobId',
                    ExpressionAttributeValues: {
                        ':jobId': { S: jobId }
                    }
                });
                const applications = await dynamodb.send(applicationsQuery);
                if (applications.Items) {
                    applications.Items.forEach(item => {
                        if (item.applicationId?.S) {
                            itemsToDelete.push({
                                DeleteRequest: {
                                    Key: {
                                        applicationId: { S: item.applicationId.S }
                                    }
                                }
                            });
                        }
                    });
                }
                // Get invitations to delete
                const invitationsQuery = new client_dynamodb_1.QueryCommand({
                    TableName: process.env.JOB_INVITATIONS_TABLE,
                    KeyConditionExpression: 'jobId = :jobId',
                    ExpressionAttributeValues: {
                        ':jobId': { S: jobId }
                    }
                });
                const invitations = await dynamodb.send(invitationsQuery);
                if (invitations.Items) {
                    invitations.Items.forEach(item => {
                        if (item.jobId?.S && item.professionalUserSub?.S) {
                            itemsToDelete.push({
                                DeleteRequest: {
                                    Key: {
                                        jobId: { S: item.jobId.S },
                                        professionalUserSub: { S: item.professionalUserSub.S }
                                    }
                                }
                            });
                        }
                    });
                }
                // Get negotiations to delete
                if (applications.Items) {
                    for (const app of applications.Items) {
                        if (app.applicationId?.S) {
                            const negotiationsQuery = new client_dynamodb_1.QueryCommand({
                                TableName: process.env.JOB_NEGOTIATIONS_TABLE,
                                KeyConditionExpression: 'applicationId = :appId',
                                ExpressionAttributeValues: {
                                    ':appId': { S: app.applicationId.S }
                                }
                            });
                            const negotiations = await dynamodb.send(negotiationsQuery);
                            if (negotiations.Items) {
                                negotiations.Items.forEach(item => {
                                    if (item.applicationId?.S && item.negotiationId?.S) {
                                        itemsToDelete.push({
                                            DeleteRequest: {
                                                Key: {
                                                    applicationId: { S: item.applicationId.S },
                                                    negotiationId: { S: item.negotiationId.S }
                                                }
                                            }
                                        });
                                    }
                                });
                            }
                        }
                    }
                }
            }
            catch (error) {
                console.log('Error collecting related items for cleanup:', error);
                // Continue with job deletion even if cleanup fails
            }
        }
        // Delete the job posting
        const deleteCommand = new client_dynamodb_1.DeleteItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            },
            ReturnValues: 'ALL_OLD'
        });
        const deletedJob = await dynamodb.send(deleteCommand);
        // Perform batch cleanup if there are related items to delete
        if (itemsToDelete.length > 0) {
            // DynamoDB batch write has a limit of 25 items per request
            const batchSize = 25;
            for (let i = 0; i < itemsToDelete.length; i += batchSize) {
                const batch = itemsToDelete.slice(i, i + batchSize);
                // Group by table name
                const requestItems = {};
                batch.forEach(item => {
                    // Determine table based on key structure
                    const keys = Object.keys(item.DeleteRequest.Key);
                    let tableName = '';
                    if (keys.includes('applicationId') && keys.includes('negotiationId')) {
                        tableName = process.env.JOB_NEGOTIATIONS_TABLE;
                    }
                    else if (keys.includes('applicationId')) {
                        tableName = process.env.JOB_APPLICATIONS_TABLE;
                    }
                    else if (keys.includes('jobId') && keys.includes('professionalUserSub')) {
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
                    const batchDeleteCommand = new client_dynamodb_1.BatchWriteItemCommand({
                        RequestItems: requestItems
                    });
                    try {
                        await dynamodb.send(batchDeleteCommand);
                    }
                    catch (error) {
                        console.error('Error in batch cleanup:', error);
                        // Don't fail the job deletion if cleanup fails
                    }
                }
            }
        }
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Job deleted successfully',
                jobId,
                deletedAt: new Date().toISOString(),
                jobType,
                forceDelete,
                cleanupPerformed: itemsToDelete.length > 0,
                relatedItemsDeleted: itemsToDelete.length,
                deletedJob: deletedJob.Attributes
            })
        };
    }
    catch (error) {
        console.error('Error deleting job posting:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
exports.handler = handler;
