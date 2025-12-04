import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  AttributeValue,
  QueryCommandInput,
  ScanCommandInput,
  UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const JOB_APPLICATIONS_TABLE: string = process.env.JOB_APPLICATIONS_TABLE!; // Non-null assertion for environment variable

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

// --- 2. Type Definitions ---

/** Interface for the data expected in the request body to update an application. */
interface UpdateApplicationBody {
  applicationId: string;
  message?: string;
  proposedRate?: number;
  availability?: string;
  startDate?: string;
  notes?: string;
}

/** Interface for the DynamoDB Application item structure (partial view used in this handler). */
interface ApplicationItem {
  applicationId?: { S: string };
  jobId?: { S: string };
  professionalUserSub?: { S: string };
  applicationStatus?: { S: string };
  [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Updates a job application initiated by a professional user.
 * It verifies token, ownership, and application status before applying updates.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;

    if (!event.body) {
      return json(400, { error: "Request body is required." });
    }

    const updateData: UpdateApplicationBody = JSON.parse(event.body);

    // Validate required fields
    if (!updateData.applicationId) {
      return json(400, { error: "Required field: applicationId" });
    }

    let applicationFound: ApplicationItem | null = null;

    // Step 1: Attempt to find the application using a GSI on applicationId
    const queryParams: QueryCommandInput = {
      TableName: JOB_APPLICATIONS_TABLE,
      IndexName: 'ApplicationIndex', // GSI on applicationId
      KeyConditionExpression: "applicationId = :applicationId",
      ExpressionAttributeValues: {
        ":applicationId": { S: updateData.applicationId }
      }
    };

    try {
      const findResponse = await dynamodb.send(new QueryCommand(queryParams));
      if (findResponse.Items && findResponse.Items.length > 0) {
        applicationFound = findResponse.Items[0] as ApplicationItem;
      }
    }
    catch (gsiError) {
      console.warn("GSI not available or query failed, attempting full table scan (SLOW):", (gsiError as Error).message);

      const scanParams: ScanCommandInput = {
        TableName: JOB_APPLICATIONS_TABLE,
        FilterExpression: "applicationId = :applicationId",
        ExpressionAttributeValues: {
          ":applicationId": { S: updateData.applicationId }
        }
      };

      const scanResponse = await dynamodb.send(new ScanCommand(scanParams));
      if (scanResponse.Items && scanResponse.Items.length > 0) {
        applicationFound = scanResponse.Items[0] as ApplicationItem;
      }
    }

    if (!applicationFound) {
      return json(404, { error: "Job application not found" });
    }

    // Step 2: Verify the application belongs to the authenticated user
    if (applicationFound.professionalUserSub?.S !== userSub) {
      return json(403, { error: "You can only update your own job applications" });
    }

    // Step 3: Check if application can be updated (not accepted/declined)
    const currentStatus: string = applicationFound.applicationStatus?.S || 'pending';
    if (currentStatus === 'accepted' || currentStatus === 'declined' || currentStatus === 'canceled' || currentStatus === 'completed') {
      return json(400, {
        error: `Cannot update application with status: ${currentStatus}`
      });
    }

    // Step 4: Build update expression
    const updateExpressions: string[] = [];
    const attributeNames: Record<string, string> = {};
    const attributeValues: Record<string, AttributeValue> = {};

    // Helper function for building updates
    const addUpdateField = (key: keyof UpdateApplicationBody, dbName: string, type: 'S' | 'N', attrName?: string) => {
      const value = updateData[key];
      if (value !== undefined && value !== null) {
        const expressionKey = attrName || dbName;
        const expressionName = `#${dbName}`;

        updateExpressions.push(`${expressionName} = :${expressionKey}`);
        attributeNames[expressionName] = dbName;

        if (type === 'S') {
          attributeValues[`:${expressionKey}`] = { S: value as string };
        } else if (type === 'N') {
          attributeValues[`:${expressionKey}`] = { N: String(value) };
        }
      }
    };

    addUpdateField('message', 'applicationMessage', 'S', 'msg');
    addUpdateField('proposedRate', 'proposedRate', 'N');
    addUpdateField('availability', 'availability', 'S');
    addUpdateField('startDate', 'startDate', 'S', 'start');
    addUpdateField('notes', 'notes', 'S');

    const nowIso: string = new Date().toISOString();
    updateExpressions.push("updatedAt = :updated");
    attributeValues[":updated"] = { S: nowIso };

    if (updateExpressions.length === 1) {
      return json(400, {
        error: "No fields to update. Provide at least one field: message, proposedRate, availability, startDate, notes"
      });
    }

    // Step 5: Perform the update
    const jobId: string | undefined = applicationFound.jobId?.S;

    if (!jobId) {
      return json(400, {
        error: "Invalid application data: missing jobId required for key"
      });
    }

    const updateCommand: UpdateItemCommandInput = {
      TableName: JOB_APPLICATIONS_TABLE,
      Key: {
        jobId: { S: jobId }, // Partition Key (PK)
        professionalUserSub: { S: userSub } // Sort Key (SK)
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: Object.keys(attributeNames).length > 0 ? attributeNames : undefined,
      ExpressionAttributeValues: attributeValues,
      ReturnValues: "ALL_NEW"
    };

    await dynamodb.send(new UpdateItemCommand(updateCommand));

    return json(200, {
      message: "Job application updated successfully",
      applicationId: updateData.applicationId,
      updatedFields: Object.keys(updateData).filter(key => key !== 'applicationId'),
      updatedAt: nowIso,
    });
  }
  catch (error: any) {
    console.error("Error updating job application:", error.message, error.stack);

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
      error: "Failed to update job application. Please try again.",
      details: error.message
    });
  }
};