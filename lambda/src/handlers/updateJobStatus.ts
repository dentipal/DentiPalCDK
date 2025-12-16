import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    GetItemCommandOutput,
    UpdateItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils"; 
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!; 

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 2. Type Definitions ---

type JobStatus = 'open' | 'scheduled' | 'action_needed' | 'completed';

const VALID_STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
    'open': ['scheduled', 'action_needed', 'completed'],
    'scheduled': ['action_needed', 'completed', 'open'], 
    'action_needed': ['scheduled', 'completed', 'open'], 
    'completed': ['open'] 
};

const VALID_STATUSES: JobStatus[] = Object.keys(VALID_STATUS_TRANSITIONS) as JobStatus[];

interface UpdateStatusBody {
    status: JobStatus;
    notes?: string;
    acceptedProfessionalUserSub?: string; 
    scheduledDate?: string; 
    completionNotes?: string; 
}

interface JobItem {
    clinicUserSub?: { S: string };
    jobId?: { S: string };
    status?: { S: string };
    statusHistory?: { L: AttributeValue[] }; 
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- STEP 1: AUTHENTICATION & INPUT PARSING ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        
        let jobId: string | undefined = event.pathParameters?.jobId;

        // Fallback: Parse from 'proxy' path if direct param is missing
        if (!jobId && event.pathParameters?.proxy) {
            const cleanPath = event.pathParameters.proxy.replace(/^\/+|\/+$/g, ''); 
            const pathParts = cleanPath.split('/');
            const jobsIndex = pathParts.indexOf("jobs");
            
            if (jobsIndex !== -1 && pathParts.length > jobsIndex + 1) {
                 jobId = pathParts[jobsIndex + 1];
            } else {
                 if (pathParts.length >= 2 && pathParts[pathParts.length - 1] === 'status') {
                     jobId = pathParts[pathParts.length - 2];
                 } else {
                     jobId = pathParts[pathParts.length - 1];
                 }
            }
        }
        
        console.log("DEBUG: Extracted Job ID:", jobId);

        if (!event.body) {
             return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Request body is required",
            });
        }

        const statusData: UpdateStatusBody = JSON.parse(event.body);

        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job ID is required",
            });
        }
        
        if (!statusData.status) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Status is required",
            });
        }

        if (!(VALID_STATUSES as string[]).includes(statusData.status)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid status",
                details: { validStatuses: VALID_STATUSES, providedStatus: statusData.status },
            });
        }

        // --- Step 2: Get current job ---
        const getParams = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        };

        const currentJobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        const currentJobItem: JobItem | undefined = currentJobResponse.Item as JobItem | undefined;

        if (!currentJobItem) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Job not found",
            });
        }
        
        if (!currentJobItem.clinicUserSub?.S || currentJobItem.clinicUserSub.S !== userSub) {
             return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
            });
        }

        // ✅ FIX STARTS HERE: Normalize "active" to "open"
        let rawStatus = currentJobItem.status?.S || 'open';
        
        // If the DB says "active", we treat it as "open" so transitions work
        if (rawStatus === 'active') {
            rawStatus = 'open';
        }

        const currentStatus: JobStatus = rawStatus as JobStatus;
        const newStatus: JobStatus = statusData.status;

        // --- Step 3: Validate status transition ---
        
        // ✅ FIX: Allow self-transition (e.g. updating notes without changing status)
        if (currentStatus !== newStatus) {
            const validTransitions: JobStatus[] = VALID_STATUS_TRANSITIONS[currentStatus];
            
            // If validTransitions is undefined (shouldn't happen now due to fix) or doesn't include new status
            if (!validTransitions || !validTransitions.includes(newStatus)) {
                return json(400, {
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Invalid status transition",
                    details: {
                        currentStatus, // This will now show "open" even if DB had "active"
                        requestedStatus: newStatus,
                        validNextStates: validTransitions
                    },
                });
            }
        }

        // --- Step 4: Validate required fields ---
        if (newStatus === 'scheduled') {
            if (!statusData.acceptedProfessionalUserSub) {
                return json(400, {
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Missing required field for scheduled status",
                    details: { requiredField: "acceptedProfessionalUserSub" },
                });
            }
            if (!statusData.scheduledDate) {
                return json(400, {
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Missing required field for scheduled status",
                    details: { requiredField: "scheduledDate" },
                });
            }
        }
        
        // --- Step 5: Build update expression ---
        const timestamp: string = new Date().toISOString();
        let updateExpression: string = 'SET #status = :status, #updatedAt = :updatedAt';
        
        const expressionAttributeNames: Record<string, string> = {
            '#status': 'status',
            '#updatedAt': 'updatedAt'
        };
        const expressionAttributeValues: Record<string, AttributeValue> = {
            ':status': { S: newStatus },
            ':updatedAt': { S: timestamp }
        };

        if (statusData.notes) {
            updateExpression += ', #notes = :notes';
            expressionAttributeNames['#notes'] = 'statusNotes';
            expressionAttributeValues[':notes'] = { S: statusData.notes };
        }
        if (statusData.acceptedProfessionalUserSub) {
            updateExpression += ', #acceptedProfessional = :acceptedProfessional';
            expressionAttributeNames['#acceptedProfessional'] = 'acceptedProfessionalUserSub';
            expressionAttributeValues[':acceptedProfessional'] = { S: statusData.acceptedProfessionalUserSub };
        }
        if (statusData.scheduledDate) {
            updateExpression += ', #scheduledDate = :scheduledDate';
            expressionAttributeNames['#scheduledDate'] = 'scheduledDate';
            expressionAttributeValues[':scheduledDate'] = { S: statusData.scheduledDate };
        }
        
        if (newStatus === 'completed') {
            updateExpression += ', #completedAt = :completedAt';
            expressionAttributeNames['#completedAt'] = 'completedAt';
            expressionAttributeValues[':completedAt'] = { S: timestamp };
            
            if (statusData.completionNotes) {
                updateExpression += ', #completionNotes = :completionNotes';
                expressionAttributeNames['#completionNotes'] = 'completionNotes';
                expressionAttributeValues[':completionNotes'] = { S: statusData.completionNotes };
            }
        }
        
        // --- Step 6: Update status history ---
        const statusHistory: AttributeValue[] = currentJobItem.statusHistory?.L || [];
        
        const newHistoryEntry: AttributeValue = {
            M: { 
                fromStatus: { S: currentStatus },
                toStatus: { S: newStatus },
                changedAt: { S: timestamp },
                changedBy: { S: userSub },
                notes: { S: statusData.notes || '' }
            }
        };

        statusHistory.push(newHistoryEntry);

        updateExpression += ', #statusHistory = :statusHistory';
        expressionAttributeNames['#statusHistory'] = 'statusHistory';
        expressionAttributeValues[':statusHistory'] = { L: statusHistory };

        // --- Step 7: Execute Update ---
        const updateParams: UpdateItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'NONE'
        };
        
        await dynamodb.send(new UpdateItemCommand(updateParams));

        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Job status updated successfully",
            data: {
                jobId,
                previousStatus: currentStatus,
                newStatus: newStatus,
                updatedAt: timestamp,
                acceptedProfessional: statusData.acceptedProfessionalUserSub || null,
                scheduledDate: statusData.scheduledDate || null
            }
        });

    } catch (error: any) {
        console.error("Error updating job status:", error.message, error.stack);
        
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to update job status",
            details: { reason: error.message }
        });
    }
};