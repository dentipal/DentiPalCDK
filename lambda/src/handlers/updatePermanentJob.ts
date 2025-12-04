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
// ✅ UPDATE: Changed import to use the new token utility
import { extractUserFromBearerToken } from "./utils"; 
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

/** Interface for the data expected in the request body (camelCase) */
interface UpdatePermanentJobBody {
    // Common fields
    professionalRole?: string;
    jobTitle?: string;
    jobDescription?: string;
    shiftSpeciality?: string;
    requirements?: string[]; // Maps to SS
    
    // Permanent-specific fields
    employmentType?: 'full_time' | 'part_time';
    salaryMin?: number; // Maps to N
    salaryMax?: number; // Maps to N
    benefits?: string[]; // Maps to SS
    vacationDays?: number; // Maps to N
    workSchedule?: string;
    startDate?: string;
    
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
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // Extract jobId. Support both standard path param and proxy path parsing.
        let jobId: string | undefined = event.pathParameters?.jobId;
        
        if (!jobId && event.pathParameters?.proxy) {
             // Assumes path is structured like /jobs/permanent/{jobId}/...
             const pathParts = event.pathParameters.proxy.split('/'); 
             jobId = pathParts[2]; 
        }

        if (!jobId) {
            return json(400, { error: "jobId is required in path parameters" });
        }
        
        if (!event.body) {
             return json(400, { error: "Request body is required." });
        }

        const updateData: UpdatePermanentJobBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getParams: GetItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                // Using composite key (clinicUserSub + jobId)
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        };

        const jobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        const existingJob: JobItem | undefined = jobResponse.Item as JobItem | undefined;

        if (!existingJob) {
            return json(404, { error: "Permanent job not found or access denied" });
        }
        
        // Verify it's the correct job type
        if (existingJob.job_type?.S !== 'permanent') {
            return json(400, {
                error: "This is not a permanent job. Use the appropriate endpoint for this job type."
            });
        }

        // --- Step 2: Build update expression and attribute values ---
        const updateExpressions: string[] = [];
        const attributeNames: Record<string, string> = {};
        const attributeValues: Record<string, AttributeValue> = {};
        let fieldsUpdatedCount: number = 0;

        // Helper function for building dynamic updates
        const addUpdateField = (dataKey: keyof UpdatePermanentJobBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS') => {
             const value = updateData[dataKey];
             if (value !== undefined && value !== null) {
                 const attrKey = `#${dbName}`;
                 // Use the dataKey (camelCase) for the value placeholder to ensure uniqueness
                 const attrValueKey = `:${String(dataKey)}`; 
                 
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
                        if (value.length > 0) {
                            attributeValues[attrValueKey] = { SS: value as string[] };
                        } else {
                            return; // Skip empty sets
                        }
                    } else {
                       console.warn(`Skipping update: Invalid value provided for SS field ${dbName}.`);
                       return;
                    }
                 }
                 fieldsUpdatedCount++;
             }
        };

        // Fields to handle (Mapping camelCase Input -> snake_case DB)
        addUpdateField('professionalRole', 'professional_role', 'S');
        addUpdateField('shiftSpeciality', 'shift_speciality', 'S');
        addUpdateField('employmentType', 'employment_type', 'S');
        addUpdateField('salaryMin', 'salary_min', 'N');
        addUpdateField('salaryMax', 'salary_max', 'N');
        addUpdateField('benefits', 'benefits', 'SS');
        addUpdateField('vacationDays', 'vacation_days', 'N');
        addUpdateField('workSchedule', 'work_schedule', 'S');
        addUpdateField('startDate', 'start_date', 'S');
        addUpdateField('jobTitle', 'job_title', 'S');
        addUpdateField('jobDescription', 'job_description', 'S');
        addUpdateField('requirements', 'requirements', 'SS');

        // Check if any fields were provided
        if (fieldsUpdatedCount === 0) {
            return json(400, { error: "No updateable fields provided in the request body." });
        }
        
        // Always update the timestamp
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
        return json(200, {
            message: "Permanent job updated successfully",
            job: {
                jobId: updatedJob?.jobId?.S || jobId,
                jobType: updatedJob?.job_type?.S || 'permanent',
                professionalRole: updatedJob?.professional_role?.S || '',
                jobTitle: updatedJob?.job_title?.S || '',
                shiftSpeciality: updatedJob?.shift_speciality?.S || '',
                employmentType: updatedJob?.employment_type?.S || '',
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
        });

    } catch (error: any) {
        const err = error as Error;
        console.error("Error updating permanent job:", err.message, err.stack);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        return json(500, {
            error: err.message || "Failed to update permanent job due to an unexpected server error."
        });
    }
};