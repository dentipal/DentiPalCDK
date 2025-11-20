import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    GetItemCommandOutput,
    UpdateItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming 'validateToken' is defined in './utils' and returns the userSub string.
import { validateToken } from "./utils"; 
// Import shared CORS headers
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

/** Map defining valid state transitions */
const VALID_STATUS_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
    'open': ['scheduled', 'action_needed', 'completed'],
    'scheduled': ['action_needed', 'completed', 'open'], // Can reopen if needed
    'action_needed': ['scheduled', 'completed', 'open'], // Can resolve negotiation
    'completed': ['open'] // Can reopen if necessary
};

const VALID_STATUSES: JobStatus[] = Object.keys(VALID_STATUS_TRANSITIONS) as JobStatus[];

/** Interface for the data expected in the request body to change status. */
interface UpdateStatusBody {
    status: JobStatus;
    notes?: string;
    acceptedProfessionalUserSub?: string; // Required for 'scheduled'
    scheduledDate?: string; // Required for 'scheduled'
    completionNotes?: string; // Used for 'completed'
}

/** Interface for the DynamoDB Job Item structure (partial view used in this handler). */
interface JobItem {
    clinicUserSub?: { S: string };
    jobId?: { S: string };
    status?: { S: string };
    statusHistory?: { L: AttributeValue[] }; // DynamoDB List type for history
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Updates the status of a specific job posting, verifies ownership, and enforces 
 * valid state transitions.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Assume validateToken returns the verified userSub (clinic owner) and throws on failure
        const userSub: string = await validateToken(event as any); 
        
        const jobId: string | undefined = event.pathParameters?.jobId;
        
        if (!event.body) {
             return json(400, { error: "Request body is required." });
        }

        const statusData: UpdateStatusBody = JSON.parse(event.body);

        if (!jobId) {
            return json(400, { error: "jobId is required in path" });
        }
        
        if (!statusData.status) {
            return json(400, { error: "status is required" });
        }

        // Validate that the new status is a recognized value
        if (!(VALID_STATUSES as string[]).includes(statusData.status)) {
            return json(400, {
                error: `Invalid status. Valid options: ${VALID_STATUSES.join(', ')}`
            });
        }

        // --- Step 1: Get current job to verify ownership and current status ---
        const getParams = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                // PK and SK used here imply a composite key on (clinicUserSub, jobId)
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        };

        const currentJobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        const currentJobItem: JobItem | undefined = currentJobResponse.Item as JobItem | undefined;

        if (!currentJobItem) {
            return json(404, { error: "Job not found or you don't have permission to update it" });
        }
        
        // Ensure job is properly structured before continuing
        if (!currentJobItem.clinicUserSub?.S || currentJobItem.clinicUserSub.S !== userSub) {
             return json(403, { error: "Access denied - ownership mismatch." });
        }

        const currentStatus: JobStatus = (currentJobItem.status?.S || 'open') as JobStatus;
        const newStatus: JobStatus = statusData.status;

        // --- Step 2: Validate status transition ---
        const validTransitions: JobStatus[] = VALID_STATUS_TRANSITIONS[currentStatus];
        if (!validTransitions || !validTransitions.includes(newStatus)) {
            return json(400, {
                error: `Invalid status transition: Cannot transition from ${currentStatus} to ${newStatus}. Valid next states: ${validTransitions.join(', ')}`
            });
        }

        // --- Step 3: Validate required fields for specific statuses ---
        if (newStatus === 'scheduled') {
            if (!statusData.acceptedProfessionalUserSub) {
                return json(400, { error: "acceptedProfessionalUserSub is required for scheduled status" });
            }
            if (!statusData.scheduledDate) {
                return json(400, { error: "scheduledDate is required for scheduled status" });
            }
        }
        
        // --- Step 4: Build update expression and attributes ---
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

        // Add optional fields based on status
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
        
        // Add completion fields if applicable
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
        
        // --- Step 5: Update status history ---
        // Retrieve the current history list (L type) or initialize it
        const statusHistory: AttributeValue[] = currentJobItem.statusHistory?.L || [];
        
        const newHistoryEntry: AttributeValue = {
            M: { // DynamoDB Map type
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
        expressionAttributeValues[':statusHistory'] = { L: statusHistory }; // Set the full updated List

        // --- Step 6: Execute Update ---
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

        // --- Step 7: Return Success ---
        return json(200, {
            message: "Job status updated successfully",
            jobId,
            previousStatus: currentStatus,
            newStatus: newStatus,
            updatedAt: timestamp,
            acceptedProfessional: statusData.acceptedProfessionalUserSub || null,
            scheduledDate: statusData.scheduledDate || null
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error updating job status:", err.message, err.stack);
        
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return json(isAuthError ? 401 : 500, {
            error: err.message || "Internal server error"
        });
    }
};