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
import { VALID_ROLE_VALUES } from "./professionalRoles";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!; // Non-null assertion for environment variable

// --- 2. Type Definitions ---

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
}

/** Interface for the DynamoDB Job Item structure (unmarshalled attributes) */
interface JobItem {
    jobId: { S: string };
    clinicUserSub: { S: string };
    job_type: { S: JobType };
    status?: { S: string };
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Allows a clinic owner to update a specific job posting.
 * Includes job type-specific validation and ensures ownership.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Auth check: Get userSub from the authorizer
        const userSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
        if (!userSub) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Unauthorized: Missing user identity.' })
            };
        }

        // Method check
        if (event.httpMethod !== 'PUT') {
            return {
                statusCode: 405,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }

        // Extract job ID from path parameters
        const jobId: string | undefined = event.pathParameters?.jobId;
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Job ID is required' })
            };
        }

        if (!event.body) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Request body is required' })
            };
        }
        
        const updateData: UpdateJobPostingBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getParams: GetItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            }
        };
        const existingJobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getParams));
        
        if (!existingJobResponse.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }
        
        const existingItem = existingJobResponse.Item as JobItem;
        const clinicUserSub: string | undefined = existingItem.clinicUserSub?.S;
        const jobType: JobType | undefined = existingItem.job_type?.S;
        const currentStatus: string = existingItem.status?.S || 'open';

        // Check for critical missing data
        if (!clinicUserSub || !jobType) {
             return {
                statusCode: 500,
                body: JSON.stringify({ error: 'Internal job data missing (clinicUserSub or job_type)' })
            };
        }

        // Security check: Only clinic owner can update their jobs
        if (userSub !== clinicUserSub) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Access denied - you can only update your own jobs' })
            };
        }

        // Prevent updates to completed jobs
        if (currentStatus === 'completed') {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Cannot update completed jobs' })
            };
        }

        // --- Step 2: Validation ---
        
        // Validate professional role
        if (updateData.professional_role && !VALID_ROLE_VALUES.includes(updateData.professional_role)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(', ')}`
                })
            };
        }

        const now = new Date();
        
        // Job type specific validation
        if (jobType === 'temporary') {
            if (updateData.date) {
                const jobDate = new Date(updateData.date);
                // Check if date is not in the past
                if (jobDate <= now) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Job date must be in the future' })
                    };
                }
            }
            if (updateData.hours && (updateData.hours < 1 || updateData.hours > 12)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Hours must be between 1 and 12' }) };
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 200)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Hourly rate must be between $10 and $200' }) };
            }
        }
        else if (jobType === 'multi_day_consulting') {
            if (updateData.dates) {
                if (!Array.isArray(updateData.dates) || updateData.dates.length === 0 || updateData.dates.length > 30) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'Dates array must have 1-30 entries' }) };
                }
                // Validate all dates are in the future
                const invalidDates = updateData.dates.filter(date => new Date(date) <= now);
                if (invalidDates.length > 0) {
                    return { statusCode: 400, body: JSON.stringify({ error: 'All dates must be in the future' }) };
                }
                // Recalculate total_days if dates are updated
                updateData.total_days = updateData.dates.length;
            }
            if (updateData.hours_per_day && (updateData.hours_per_day < 1 || updateData.hours_per_day > 12)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Hours per day must be between 1 and 12' }) };
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 300)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Hourly rate must be between $10 and $300' }) };
            }
        }
        else if (jobType === 'permanent') {
            if (updateData.salary_min && (updateData.salary_min < 20000 || updateData.salary_min > 500000)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Minimum salary must be between $20,000 and $500,000' }) };
            }
            if (updateData.salary_max && updateData.salary_min && updateData.salary_max <= updateData.salary_min) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Maximum salary must be greater than minimum salary' }) };
            }
            if (updateData.vacation_days && (updateData.vacation_days < 0 || updateData.vacation_days > 50)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Vacation days must be between 0 and 50' }) };
            }
            if (updateData.employment_type && !['full_time', 'part_time'].includes(updateData.employment_type)) {
                return { statusCode: 400, body: JSON.stringify({ error: 'Employment type must be full_time or part_time' }) };
            }
            // benefits validation (assuming it's a string set, checking for array type is sufficient)
            if (updateData.benefits && !Array.isArray(updateData.benefits)) {
                 return { statusCode: 400, body: JSON.stringify({ error: 'Benefits must be an array of strings' }) };
            }
        }

        // --- Step 3: Build Update Expression ---
        const updateExpressions: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, AttributeValue> = {};
        let fieldsUpdatedCount = 0;

        // Helper function to add a field to the update expression
        const addUpdateField = (key: keyof UpdateJobPostingBody, dbName: string, type: 'S' | 'N' | 'BOOL' | 'SS', expressionName?: string) => {
             const value = updateData[key];
             if (value !== undefined && value !== null) {
                 const attrName = expressionName || dbName;
                 const attrKey = `#${dbName}`;
                 
                 updateExpressions.push(`${attrKey} = :${attrName}`);
                 expressionAttributeNames[attrKey] = dbName;
                 
                 // Type conversion for DynamoDB AttributeValue
                 if (type === 'S') {
                     expressionAttributeValues[`:${attrName}`] = { S: value as string };
                 } else if (type === 'N') {
                     expressionAttributeValues[`:${attrName}`] = { N: String(value) };
                 } else if (type === 'BOOL') {
                     expressionAttributeValues[`:${attrName}`] = { BOOL: value as boolean };
                 } else if (type === 'SS') {
                    // For string set (SS) or list (L - which is typically preferred but SS was in original logic for 'dates' and 'benefits')
                    if (Array.isArray(value)) {
                       expressionAttributeValues[`:${attrName}`] = { SS: value as string[] };
                    } else {
                       console.warn(`Attempted to save non-array value for SS field ${dbName}`);
                       return; // Skip if type doesn't match
                    }
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
            // Note: Dates is treated as SS (String Set) which may have limitations in DynamoDB, 
            // but matching original logic. If dates are large/order matters, L (List) should be used.
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
            addUpdateField('benefits', 'benefits', 'SS'); // Matching original SS logic
            addUpdateField('vacation_days', 'vacation_days', 'N', 'vd');
            addUpdateField('work_schedule', 'work_schedule', 'S', 'ws');
            addUpdateField('start_date', 'start_date', 'S', 'sd');
        }
        
        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'No valid fields to update' })
            };
        }

        // Add updated timestamp
        const updatedTimestamp: string = now.toISOString();
        updateExpressions.push('updated_at = :updated_at');
        expressionAttributeValues[':updated_at'] = { S: updatedTimestamp };

        // --- Step 4: Update the job ---
        const updateCommand: UpdateItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await dynamodb.send(new UpdateItemCommand(updateCommand));

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Job updated successfully',
                jobId,
                updatedAt: updatedTimestamp,
                fieldsUpdated: Object.keys(updateData).filter(key => updateData[key as keyof UpdateJobPostingBody] !== undefined),
                updatedJob: result.Attributes
            })
        };
    }
    catch (error) {
        console.error('Error updating job posting:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error', details: (error as Error).message })
        };
    }
};