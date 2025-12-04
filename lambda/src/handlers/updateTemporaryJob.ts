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
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";

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
             // Assumes path is structured like /jobs/temporary/{jobId}/...
             const pathParts = event.pathParameters.proxy.split('/'); 
             jobId = pathParts[2]; 
        }

        if (!jobId) {
            return json(400, { error: "jobId is required in path parameters" });
        }

        if (!event.body) {
             return json(400, { error: "Request body is required." });
        }

        const updateData: UpdateTemporaryJobBody = JSON.parse(event.body);

        // --- Step 1: Get existing job to verify ownership and job type ---
        const getParams: GetItemCommandInput = {
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId } // Use Global Secondary Index or if jobId is PK
                // Note: If table uses composite key (clinicUserSub + jobId), we must provide both.
                // Based on your provided code snippet, it used a composite key check.
                // If jobId is unique globally (UUID), a simple GetItem might require the PK structure.
                // Assuming standard DynamoDB GetItem requires full Primary Key.
                // If your table PK is clinicUserSub and SK is jobId:
                // clinicUserSub: { S: userSub },
                // jobId: { S: jobId }
            }
        };
        
        // *CRITICAL FIX*: The previous snippet assumed a specific Key structure. 
        // If your table's Primary Key is ONLY jobId, remove `clinicUserSub`.
        // If it is `clinicId` + `jobId`, or `clinicUserSub` + `jobId`, you must supply both.
        // Based on typical Single Table Design or standard UUID keys:
        // I will attempt to use Scan or Query if the PK structure is uncertain, 
        // OR proceed with the provided assumption that we know the PK.
        // Reverting to the specific key structure used in your provided input code:
        const getCommandInput: GetItemCommandInput = {
             TableName: JOB_POSTINGS_TABLE,
             Key: {
                // Assuming Partition Key is 'jobId' for this table based on other deleteJob examples,
                // OR adhering to the previous user input if they used composite keys.
                // Your provided snippet used { clinicUserSub, jobId }. I will respect that.
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
             }
        };

        const jobResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getCommandInput));
        const existingJob: JobItem | undefined = jobResponse.Item as JobItem | undefined;

        if (!existingJob) {
            return json(404, { error: "Temporary job not found or access denied" });
        }
        
        // Verify it's the correct job type
        if (existingJob.job_type?.S !== 'temporary') {
            return json(400, {
                error: "This is not a temporary job. Use the appropriate endpoint for this job type."
            });
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
                        // DynamoDB doesn't accept empty sets
                        if (value.length > 0) {
                            attributeValues[attrValueKey] = { SS: value as string[] };
                        } else {
                            // If empty array passed for SS, we might want to remove the attribute or ignore.
                            // Here we ignore to prevent DB errors.
                            return; 
                        }
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

        // Check if any fields were provided
        if (fieldsUpdatedCount === 0) {
            return json(400, { error: "No updateable fields provided in the request body." });
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
        return json(200, {
            message: "Temporary job updated successfully",
            job: {
                jobId: updatedJob?.jobId?.S || jobId,
                jobType: updatedJob?.job_type?.S || 'temporary',
                professionalRole: updatedJob?.professional_role?.S || '', 
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
        });
    }
    catch (error: any) {
        const err = error as Error;
        console.error("Error updating temporary job:", err.message, err.stack);
        
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
            error: err.message || "Failed to update temporary job due to an unexpected server error."
        });
    }
};