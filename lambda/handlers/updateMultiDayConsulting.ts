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

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!; // Non-null assertion for environment variable

// --- 2. Type Definitions ---

/** Interface for the data expected in the request body (camelCase) */
interface UpdateMultiDayConsultingBody {
    professionalRole?: string;
    jobTitle?: string;
    description?: string;
    requirements?: string[]; // Maps to SS
    dates?: string[]; // Maps to SS
    startTime?: string; // Maps to start_time
    endTime?: string; // Maps to end_time
    mealBreak?: boolean; // Maps to BOOL
    hourlyRate?: number; // Maps to N
    totalDays?: number; // Maps to N
}

/** Interface for the DynamoDB Job Item structure (unmarshalled attributes, partial view) */
interface JobItem {
    clinicUserSub?: { S: string };
    jobId?: { S: string };
    job_type?: { S: string }; // Expected to be 'multi_day_consulting'
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Allows a clinic owner to update fields specific to a multi-day consulting job.
 * Enforces ownership and job type.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Assume validateToken is synchronous or safely called. Check the utils implementation.
        // Based on other handlers, we'll keep it as a synchronous call but you may need to add 'await'
        // depending on your actual utils.ts.
        const userSub: string = await validateToken(event as any); 

        // Extract jobId from the proxy path (e.g., /.../jobs/multi-day-consulting/{jobId}/...)
        const pathParts: string[] | undefined = event.pathParameters?.proxy?.split('/'); 
        // Assumes path is structured such that jobId is the third part of the proxy parameter (index 2)
        const jobId: string | undefined = pathParts?.[2]; 

        if (!jobId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "jobId is required in path parameters" })
            };
        }

        if (!event.body) {
             return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Request body is required." }) };
        }

        const updateData: UpdateMultiDayConsultingBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        // Use clinicUserSub and jobId as the composite key for high-speed, owner-verified lookup
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
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "Multi-day consulting job not found or access denied" })
            };
        }
        
        // Verify it's the correct job type
        if (existingJob.job_type?.S !== 'multi_day_consulting') {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // --- Step 2: Build update expression and attribute values ---
        const updateExpressions: string[] = [];
        const attributeNames: Record<string, string> = {};
        const attributeValues: Record<string, AttributeValue> = {};
        let fieldsUpdatedCount: number = 0;

        // Helper function for building dynamic updates
        // This function handles the camelCase (updateData key) to snake_case (DB attribute) mapping.
        const addUpdateField = (dataKey: keyof UpdateMultiDayConsultingBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS') => {
             const value = updateData[dataKey];
             if (value !== undefined && value !== null) {
                 const attrKey = `#${dbName}`; // E.g., #professional_role
                 const attrValueKey = `:${dataKey}`; // E.g., :professionalRole
                 
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
        addUpdateField('professionalRole', 'professional_role', 'S');
        addUpdateField('jobTitle', 'job_title', 'S');
        addUpdateField('description', 'description', 'S');
        addUpdateField('requirements', 'requirements', 'SS');
        addUpdateField('dates', 'dates', 'SS');
        addUpdateField('startTime', 'start_time', 'S');
        addUpdateField('endTime', 'end_time', 'S');
        addUpdateField('mealBreak', 'meal_break', 'BOOL');
        addUpdateField('hourlyRate', 'hourly_rate', 'N');
        addUpdateField('totalDays', 'total_days', 'N');

        // Check if any fields were provided other than the mandatory timestamp
        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
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
            ExpressionAttributeNames: attributeNames,
            ExpressionAttributeValues: attributeValues,
            ReturnValues: "ALL_NEW"
        };
        
        const updateResponse = await dynamodb.send(new UpdateItemCommand(updateCommand));
        const updatedJob = updateResponse.Attributes;

        // --- Step 4: Return structured response ---
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                message: "Multi-day consulting job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || jobId,
                    jobType: updatedJob?.job_type?.S || 'multi_day_consulting',
                    professionalRole: updatedJob?.professional_role?.S || '',
                    jobTitle: updatedJob?.job_title?.S || '',
                    description: updatedJob?.description?.S || '',
                    requirements: updatedJob?.requirements?.SS || [],
                    dates: updatedJob?.dates?.SS || [],
                    startTime: updatedJob?.start_time?.S || '',
                    endTime: updatedJob?.end_time?.S || '',
                    // Safely parse number types for the response payload
                    hourlyRate: updatedJob?.hourly_rate?.N ? parseFloat(updatedJob.hourly_rate.N) : 0,
                    totalDays: updatedJob?.total_days?.N ? parseInt(updatedJob.total_days.N, 10) : 0,
                    mealBreak: updatedJob?.meal_break?.BOOL || false,
                    status: updatedJob?.status?.S || 'active',
                    updatedAt: updatedTimestamp
                }
            })
        };
    } catch (error) {
        const err = error as Error;
        console.error("Error updating multi-day consulting job:", err.message, err.stack);
        
        // Use 400 status for invalid data errors from JSON.parse or validation.
        const statusCode = err.message.includes("Unauthorized") ? 401 : 
                           err.message.includes("not a multi-day") ? 400 : 
                           500;

        return {
            statusCode: statusCode,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                error: err.message || "Failed to update multi-day consulting job due to an unexpected server error."
            })
        };
    }
};