import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    GetItemCommandInput,
    UpdateItemCommandInput,
    GetItemCommandOutput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming 'validateToken' is defined in './utils' and returns the userSub string.
import { validateToken } from "./utils"; 

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!; // Non-null assertion for environment variable

// --- 2. Type Definitions ---

/** Interface for the data expected in the request body (camelCase) */
interface UpdateTemporaryJobBody {
    jobTitle?: string;
    description?: string;
    requirements?: string[]; // Maps to SS
    date?: string; // Maps to date
    startTime?: string; // Maps to start_time
    endTime?: string; // Maps to end_time
    hourlyRate?: number; // Maps to N
    mealBreak?: boolean; // Maps to BOOL
    [key: string]: any; 
}

/** Interface for the DynamoDB Job Item structure (partial view) */
interface JobItem {
    clinicUserSub?: { S: string };
    jobId?: { S: string };
    job_type?: { S: string }; // Expected to be 'temporary'
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Allows a clinic owner to update fields specific to a temporary job posting.
 * Enforces ownership and job type validation.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Validate the token and get the userSub (clinic owner)
        const userSub: string = await validateToken(event); 

        // Extract jobId from the proxy path (e.g., /.../jobs/temporary/{jobId}/...)
        const pathParts: string[] | undefined = event.pathParameters?.proxy?.split('/'); 
        // Assumes path is structured such that jobId is the third part of the proxy parameter (index 2)
        const jobId: string | undefined = pathParts?.[2]; 

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "jobId is required in path parameters" })
            };
        }

        if (!event.body) {
             return { statusCode: 400, body: JSON.stringify({ error: "Request body is required." }) };
        }

        const updateData: UpdateTemporaryJobBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getParams: GetItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        };

        const jobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        const existingJob: JobItem | undefined = jobResponse.Item as JobItem | undefined;

        if (!existingJob) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Temporary job not found or access denied" })
            };
        }
        
        // Verify it's the correct job type
        if (existingJob.job_type?.S !== 'temporary') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // --- Step 2: Build update expression and attribute values ---
        const updateExpressions: string[] = [];
        const attributeNames: Record<string, string> = {};
        const attributeValues: Record<string, AttributeValue> = {};
        let fieldsUpdatedCount: number = 0;

        // Helper function for building dynamic updates
        const addUpdateField = (dataKey: keyof UpdateTemporaryJobBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS') => {
             const value = updateData[dataKey];
             if (value !== undefined && value !== null) {
                 const attrKey = `#${dbName}`;
                 const attrValueKey = `:${dataKey}`; // Use camelCase key for value reference
                 
                 updateExpressions.push(`${attrKey} = ${attrValueKey}`);
                 attributeNames[attrKey] = dbName;
                 
                 // Type conversion for DynamoDB AttributeValue
                 if (type === 'S') {
                     attributeValues[attrValueKey] = { S: value as string };
                 } else if (type === 'N') {
                     attributeValues[attrValueKey] = { N: String(value) };
                 } else if (type === 'BOOL') {
                     attributeValues[attrValueKey] = { BOOL: value as boolean };
                 } else if (type === 'SS') {
                    if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
                       attributeValues[attrValueKey] = { SS: value as string[] };
                    } else {
                       console.warn(`Skipping update: Invalid value provided for SS field ${dbName}.`);
                       return;
                    }
                 }
                 fieldsUpdatedCount++;
             }
        };

        // Fields mapping from camelCase request body to snake_case DynamoDB
        addUpdateField('jobTitle', 'job_title', 'S');
        addUpdateField('description', 'description', 'S');
        addUpdateField('requirements', 'requirements', 'SS');
        addUpdateField('date', 'date', 'S');
        addUpdateField('startTime', 'start_time', 'S');
        addUpdateField('endTime', 'end_time', 'S');
        addUpdateField('hourlyRate', 'hourly_rate', 'N');
        addUpdateField('mealBreak', 'meal_break', 'BOOL');
        // Note: professional_role and shift_speciality are often common fields but not included in original JS data mapping for temporary job.

        // Check if any fields were provided
        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No updateable fields provided in the request body." })
            };
        }
        
        // Always update the timestamp
        const updatedTimestamp: string = new Date().toISOString();
        const updatedTimestampName = "#updatedAt";
        const updatedTimestampKey = ":updatedAt";
        updateExpressions.push(`${updatedTimestampName} = ${updatedTimestampKey}`);
        attributeNames[updatedTimestampName] = "updated_at";
        attributeValues[updatedTimestampKey] = { S: updatedTimestamp };


        // --- Step 3: Execute the Update ---
        const updateCommand: UpdateItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            },
            UpdateExpression: `SET ${updateExpressions.join(", ")}`,
            ExpressionAttributeNames: attributeNames,
            ExpressionAttributeValues: attributeValues,
            ReturnValues: "ALL_NEW"
        };
        
        const updateResponse = await dynamodb.send(new UpdateItemCommand(updateCommand));
        const updatedJob = updateResponse.Attributes;

        // --- Step 4: Return structured response ---
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Temporary job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || jobId,
                    jobType: updatedJob?.job_type?.S || 'temporary',
                    professionalRole: updatedJob?.professional_role?.S || '', // Assuming these exist from initial job creation
                    jobTitle: updatedJob?.job_title?.S || '',
                    description: updatedJob?.description?.S || '',
                    requirements: updatedJob?.requirements?.SS || [],
                    date: updatedJob?.date?.S || '',
                    startTime: updatedJob?.start_time?.S || '',
                    endTime: updatedJob?.end_time?.S || '',
                    hourlyRate: updatedJob?.hourly_rate?.N ? parseFloat(updatedJob.hourly_rate.N) : 0,
                    mealBreak: updatedJob?.meal_break?.BOOL || false,
                    status: updatedJob?.status?.S || 'active',
                    updatedAt: updatedTimestamp
                }
            })
        };
    }
    catch (error) {
        const err = error as Error;
        console.error("Error updating temporary job:", err.message, err.stack);
        
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return {
            statusCode: isAuthError ? 401 : 500,
            body: JSON.stringify({
                error: err.message || "Failed to update temporary job due to an unexpected server error."
            })
        };
    }
};