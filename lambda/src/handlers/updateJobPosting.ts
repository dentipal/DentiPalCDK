import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
import { VALID_ROLE_VALUES } from "./professionalRoles";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!; 

// Initialize V3 Client and Document Client
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 3. Type Definitions ---

/** Union type for allowed job types */
type JobType = 'temporary' | 'multi_day_consulting' | 'permanent';

/** Interface for the data expected in the request body (input fields) */
interface UpdateJobPostingBody {
    // Common fields
    professional_role?: string;
    shift_speciality?: string;
    assisted_hygiene?: boolean;
    meal_break?: boolean;
    
    // Temporary/Multi-Day fields
    date?: string; // Used by temporary
    hours?: number; // Used by temporary
    hourly_rate?: number; // Used by temporary/multi_day_consulting
    
    // Multi-Day fields
    dates?: string[];
    total_days?: number; // Calculated field
    hours_per_day?: number;
    project_duration?: string;
    
    // Permanent fields
    employment_type?: 'full_time' | 'part_time';
    salary_min?: number;
    salary_max?: number;
    benefits?: string[];
    vacation_days?: number;
    work_schedule?: string;
    start_date?: string;
    
    [key: string]: any;
}

/** Interface for the DynamoDB Job Item structure (Unmarshalled) */
interface JobItem {
    jobId: string;
    clinicUserSub: string;
    job_type: JobType;
    status?: string;
    [key: string]: any;
}

// --- 4. Handler Function ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    if (method !== 'PUT') {
        return json(405, {
            error: "Method Not Allowed",
            statusCode: 405,
            message: "Only PUT method is supported",
            details: { allowedMethods: ["PUT"] },
            timestamp: new Date().toISOString()
        });
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // Extract job ID from path parameters
        const jobId: string | undefined = event.pathParameters?.jobId;
        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job ID is required",
                details: { pathFormat: "PUT /job-postings/{jobId}" },
                timestamp: new Date().toISOString()
            });
        }

        if (!event.body) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Request body is required",
                details: { hint: "Provide JSON body with fields to update" },
                timestamp: new Date().toISOString()
            });
        }
        
        const updateData: UpdateJobPostingBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getCommand = new GetCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: { jobId: jobId }
        });
        
        const existingJobResponse = await ddbDoc.send(getCommand);
        
        if (!existingJobResponse.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Job not found",
                details: { jobId: jobId },
                timestamp: new Date().toISOString()
            });
        }
        
        const existingItem = existingJobResponse.Item as JobItem;
        const clinicUserSub = existingItem.clinicUserSub;
        const jobType = existingItem.job_type;
        const currentStatus = existingItem.status || 'open';

        // Check for critical missing data
        if (!clinicUserSub || !jobType) {
             return json(500, {
                 error: "Internal Server Error",
                 statusCode: 500,
                 message: "Internal job data incomplete",
                 details: { missingFields: [!clinicUserSub ? "clinicUserSub" : "", !jobType ? "job_type" : ""].filter(Boolean) },
                 timestamp: new Date().toISOString()
             });
        }

        // Security check: Only clinic owner can update their jobs
        if (userSub !== clinicUserSub) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { reason: "Only job creator can update" },
                timestamp: new Date().toISOString()
            });
        }

        // Prevent updates to completed jobs
        if (currentStatus === 'completed') {
            return json(409, {
                error: "Conflict",
                statusCode: 409,
                message: "Cannot update completed jobs",
                details: { currentStatus: currentStatus },
                timestamp: new Date().toISOString()
            });
        }

        // --- Step 2: Validation ---
        
        // Validate professional role
        if (updateData.professional_role && !VALID_ROLE_VALUES.includes(updateData.professional_role)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES, received: updateData.professional_role },
                timestamp: new Date().toISOString()
            });
        }

        const now = new Date();
        
        // Job type specific validation
        if (jobType === 'temporary') {
            if (updateData.date) {
                const jobDate = new Date(updateData.date);
                if (jobDate <= now) {
                    return json(400, { error: 'Job date must be in the future' });
                }
            }
            if (updateData.hours && (updateData.hours < 1 || updateData.hours > 12)) {
                return json(400, { error: 'Hours must be between 1 and 12' });
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 200)) {
                return json(400, { error: 'Hourly rate must be between $10 and $200' });
            }
        }
        else if (jobType === 'multi_day_consulting') {
            if (updateData.dates) {
                if (!Array.isArray(updateData.dates) || updateData.dates.length === 0 || updateData.dates.length > 30) {
                    return json(400, { error: 'Dates array must have 1-30 entries' });
                }
                // Validate all dates are in the future
                const invalidDates = updateData.dates.filter(date => new Date(date) <= now);
                if (invalidDates.length > 0) {
                    return json(400, { error: 'All dates must be in the future' });
                }
                // Recalculate total_days if dates are updated
                updateData.total_days = updateData.dates.length;
            }
            if (updateData.hours_per_day && (updateData.hours_per_day < 1 || updateData.hours_per_day > 12)) {
                return json(400, { error: 'Hours per day must be between 1 and 12' });
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 300)) {
                return json(400, { error: 'Hourly rate must be between $10 and $300' });
            }
        }
        else if (jobType === 'permanent') {
            if (updateData.salary_min && (updateData.salary_min < 20000 || updateData.salary_min > 500000)) {
                return json(400, { error: 'Minimum salary must be between $20,000 and $500,000' });
            }
            if (updateData.salary_max && updateData.salary_min && updateData.salary_max <= updateData.salary_min) {
                return json(400, { error: 'Maximum salary must be greater than minimum salary' });
            }
            if (updateData.vacation_days && (updateData.vacation_days < 0 || updateData.vacation_days > 50)) {
                return json(400, { error: 'Vacation days must be between 0 and 50' });
            }
            if (updateData.employment_type && !['full_time', 'part_time'].includes(updateData.employment_type)) {
                return json(400, { error: 'Employment type must be full_time or part_time' });
            }
            if (updateData.benefits && !Array.isArray(updateData.benefits)) {
                 return json(400, { error: 'Benefits must be an array of strings' });
            }
        }

        // --- Step 3: Build Update Expression ---
        const updateExpressions: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, any> = {}; // any because DocumentClient handles marshalling
        let fieldsUpdatedCount = 0;

        // Helper function to add a field to the update expression
        const addUpdateField = (key: keyof UpdateJobPostingBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS', expressionName?: string) => {
             const value = updateData[key];
             if (value !== undefined && value !== null) {
                 const attrName = expressionName || dbName;
                 const attrKey = `#${dbName}`;
                 
                 updateExpressions.push(`${attrKey} = :${attrName}`);
                 expressionAttributeNames[attrKey] = dbName;
                 
                 // For String Sets (SS), DocumentClient marshalls JavaScript Sets.
                 // If we pass an array, it might be marshalled as a List (L) by default.
                 // To strictly adhere to the 'SS' type intent, we convert arrays to Sets.
                 if (type === 'SS' && Array.isArray(value)) {
                     expressionAttributeValues[`:${attrName}`] = new Set(value);
                 } else {
                     expressionAttributeValues[`:${attrName}`] = value;
                 }
                 fieldsUpdatedCount++;
             }
        };

        // Common fields
        addUpdateField('professional_role', 'professional_role', 'S', 'pr');
        addUpdateField('shift_speciality', 'shift_speciality', 'S', 'ss');
        addUpdateField('assisted_hygiene', 'assisted_hygiene', 'BOOL', 'ah');
        addUpdateField('meal_break', 'meal_break', 'BOOL', 'mb');

        // Job type specific fields
        if (jobType === 'temporary') {
            addUpdateField('date', 'date', 'S', 'd');
            addUpdateField('hours', 'hours', 'N', 'h');
            addUpdateField('hourly_rate', 'hourly_rate', 'N', 'hr');
        }
        else if (jobType === 'multi_day_consulting') {
            addUpdateField('dates', 'dates', 'SS'); 
            addUpdateField('total_days', 'total_days', 'N', 'td');
            addUpdateField('hours_per_day', 'hours_per_day', 'N', 'hpd');
            addUpdateField('hourly_rate', 'hourly_rate', 'N', 'hr');
            addUpdateField('project_duration', 'project_duration', 'S', 'pd');
        }
        else if (jobType === 'permanent') {
            addUpdateField('employment_type', 'employment_type', 'S', 'et');
            addUpdateField('salary_min', 'salary_min', 'N', 'smin');
            addUpdateField('salary_max', 'salary_max', 'N', 'smax');
            addUpdateField('benefits', 'benefits', 'SS'); 
            addUpdateField('vacation_days', 'vacation_days', 'N', 'vd');
            addUpdateField('work_schedule', 'work_schedule', 'S', 'ws');
            addUpdateField('start_date', 'start_date', 'S', 'sd');
        }
        
        if (fieldsUpdatedCount === 0) {
            return json(400, { error: 'No valid fields to update' });
        }

        // Add updated timestamp
        const updatedTimestamp: string = now.toISOString();
        updateExpressions.push('#updated_at = :updated_at');
        expressionAttributeNames['#updated_at'] = 'updated_at';
        expressionAttributeValues[':updated_at'] = updatedTimestamp;

        // --- Step 4: Update the job ---
        const updateCommand: UpdateCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: { jobId: jobId },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await ddbDoc.send(new UpdateCommand(updateCommand));

        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Job updated successfully",
            data: {
                jobId,
                updatedAt: updatedTimestamp,
                fieldsUpdated: Object.keys(updateData).filter(key => updateData[key as keyof UpdateJobPostingBody] !== undefined),
                updatedJob: result.Attributes
            },
            timestamp: new Date().toISOString()
        });
    }
    catch (error: any) {
        console.error('Error updating job posting:', error);
        
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
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to update job",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};