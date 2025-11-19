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

/** Interface for the data expected in the request body (snake_case/camelCase mix from original JS) */
interface UpdatePermanentJobBody {
    // Common fields
    professional_role?: string;
    job_title?: string;
    job_description?: string;
    shift_speciality?: string;
    requirements?: string[]; // Maps to SS
    
    // Permanent-specific fields
    employment_type?: 'full_time' | 'part_time';
    salary_min?: number; // Maps to N
    salary_max?: number; // Maps to N
    benefits?: string[]; // Maps to SS
    vacation_days?: number; // Maps to N
    work_schedule?: string;
    start_date?: string;
    
    // Original JS uses snake_case here but camelCase in other handlers, normalizing field names
    [key: string]: any; 
}

/** Interface for the DynamoDB Job Item structure (partial view) */
interface JobItem {
    clinicUserSub?: { S: string };
    jobId?: { S: string };
    job_type?: { S: string }; // Expected to be 'permanent'
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Allows a clinic owner to update fields specific to a permanent job posting.
 * Enforces ownership and job type.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Validate the token and get the userSub (clinic owner)
        const userSub: string = validateToken(event); 

        // Extract jobId from the proxy path (e.g., /.../jobs/permanent/{jobId}/...)
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

        const updateData: UpdatePermanentJobBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getParams: GetItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                // Use clinicUserSub and jobId as the composite key for verified lookup
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        };

        const jobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        const existingJob: JobItem | undefined = jobResponse.Item as JobItem | undefined;

        if (!existingJob) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Permanent job not found or access denied" })
            };
        }
        
        // Verify it's the correct job type
        if (existingJob.job_type?.S !== 'permanent') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a permanent job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // --- Step 2: Build update expression and attribute values ---
        const updateExpressions: string[] = [];
        const attributeNames: Record<string, string> = {};
        const attributeValues: Record<string, AttributeValue> = {};
        let fieldsUpdatedCount: number = 0;

        // Helper function for building dynamic updates
        const addUpdateField = (dataKey: keyof UpdatePermanentJobBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS', expressionName?: string) => {
             const value = updateData[dataKey];
             if (value !== undefined && value !== null) {
                 const attrKey = `#${dbName}`;
                 const attrValueKey = `:${expressionName || dbName}`;
                 
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

        // Fields to handle
        addUpdateField('professional_role', 'professional_role', 'S', 'professionalRole');
        addUpdateField('shift_speciality', 'shift_speciality', 'S', 'shiftSpeciality');
        addUpdateField('employment_type', 'employment_type', 'S', 'employmentType');
        addUpdateField('salary_min', 'salary_min', 'N', 'salaryMin');
        addUpdateField('salary_max', 'salary_max', 'N', 'salaryMax');
        addUpdateField('benefits', 'benefits', 'SS');
        addUpdateField('vacation_days', 'vacation_days', 'N', 'vacationDays');
        addUpdateField('work_schedule', 'work_schedule', 'S', 'workSchedule');
        addUpdateField('start_date', 'start_date', 'S', 'startDate');
        addUpdateField('job_title', 'job_title', 'S', 'jobTitle');
        addUpdateField('job_description', 'job_description', 'S', 'jobDescription'); // Mapping description
        addUpdateField('requirements', 'requirements', 'SS');

        // Check if any fields were provided other than the mandatory timestamp
        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No updateable fields provided in the request body." })
            };
        }
        
        // Always update the timestamp (must be done after field check)
        const updatedTimestamp: string = new Date().toISOString();
        updateExpressions.push("#updatedAt = :updatedAt");
        attributeNames["#updatedAt"] = "updated_at";
        attributeValues[":updatedAt"] = { S: updatedTimestamp };

        // --- Step 3: Execute the Update ---
        const updateCommand: UpdateItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            },
            UpdateExpression: `SET ${updateExpressions.join(", ")}`,
            // Only include ExpressionAttributeNames if needed (i.e., when using aliases like #updatedAt)
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
                message: "Permanent job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || jobId,
                    jobType: updatedJob?.job_type?.S || 'permanent',
                    professionalRole: updatedJob?.professional_role?.S || '',
                    jobTitle: updatedJob?.job_title?.S || '',
                    shiftSpeciality: updatedJob?.shift_speciality?.S || '',
                    employmentType: updatedJob?.employment_type?.S || '',
                    // Safely parse number types for the response payload
                    salaryMin: updatedJob?.salary_min?.N ? parseFloat(updatedJob.salary_min.N) : 0,
                    salaryMax: updatedJob?.salary_max?.N ? parseFloat(updatedJob.salary_max.N) : 0,
                    benefits: updatedJob?.benefits?.SS || [],
                    vacationDays: updatedJob?.vacation_days?.N ? parseInt(updatedJob.vacation_days.N, 10) : 0,
                    workSchedule: updatedJob?.work_schedule?.S || '',
                    startDate: updatedJob?.start_date?.S || '',
                    jobDescription: updatedJob?.job_description?.S || '',
                    requirements: updatedJob?.requirements?.SS || [],
                    updatedAt: updatedTimestamp
                }
            })
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error updating permanent job:", err.message, err.stack);
        
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return {
            statusCode: isAuthError ? 401 : 500,
            body: JSON.stringify({
                error: err.message || "Failed to update permanent job due to an unexpected server error."
            })
        };
    }
};