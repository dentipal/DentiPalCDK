import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

// Assuming 'validateToken' is a TypeScript function now, 
// its return type is assumed to be 'Promise<string>' (the userSub).
// The path may need adjustment based on your project structure.
import { validateToken } from "./utils"; 

// --- Interfaces and Type Definitions ---

// Define a type for the DynamoDB client connection
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Allowed groups for job deletion
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

// Define CORS headers for the response
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": "true",
};

// Define the structure for the API Gateway Lambda event
interface APIGatewayEvent {
  pathParameters?: {
    proxy?: string;
  };
  requestContext?: {
    authorizer?: {
      claims?: {
        "cognito:groups"?: string;
      };
    };
  };
  // Assuming 'validateToken' uses this event or similar structure
  headers?: { [key: string]: string | undefined };
  [key: string]: any; 
}

// Define the structure for the Lambda response
interface LambdaResponse {
  statusCode: number;
  headers: typeof CORS_HEADERS;
  body: string;
}

// --- Lambda Handler Function ---

export const handler = async (event: APIGatewayEvent): Promise<LambdaResponse> => {
  try {
    // Step 1: Validate token and get userSub
    // Assuming validateToken takes the APIGatewayEvent and returns the userSub string
    const userSub: string = await validateToken(event);
    console.log("Authenticated userSub:", userSub);

    // Step 2: Extract Cognito groups and perform authorization
    const groupsClaim: string =
      event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";
    
    // Process groups: split, convert to lowercase, and filter out empty strings
    const groups: string[] = groupsClaim.split(",").map(g => g.toLowerCase()).filter(Boolean);
    console.log("User groups:", groups);

    const isAllowed: boolean = groups.some(g => ALLOWED_GROUPS.has(g));

    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "You do not have permission to delete this job.",
        }),
      };
    }

    // Step 3: Extract jobId from proxy path
    const pathParts: string[] = event.pathParameters?.proxy?.split("/") || [];
    const jobId: string = pathParts[2] || ""; // Expected path: /jobs/permanent/{jobId}

    if (!jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "jobId is required in path parameters",
        }),
      };
    }

    // Step 4: Verify the job exists and belongs to the clinic (using clinicUserSub as Partition Key)
    const getJobCommand = new GetItemCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub }, // Primary Key Part 1 (Partition Key)
        jobId: { S: jobId },           // Primary Key Part 2 (Sort Key)
      },
    });
    const jobResponse = await dynamodb.send(getJobCommand);

    if (!jobResponse.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Permanent job not found or access denied",
        }),
      };
    }

    const job = jobResponse.Item;

    // Step 5: Verify it's a permanent job
    if (job.job_type?.S !== "permanent") {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "This is not a permanent job. Use the appropriate endpoint for this job type.",
        }),
      };
    }

    // Step 6: Check for active applications
    const applicationsCommand = new QueryCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      // Assuming 'jobId' is the Partition Key of the JOB_APPLICATIONS_TABLE
      KeyConditionExpression: "jobId = :jobId", 
      FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
      ExpressionAttributeValues: {
        ":jobId": { S: jobId },
        ":pending": { S: "pending" },
        ":accepted": { S: "accepted" },
        ":negotiating": { S: "negotiating" },
      },
    });
    const applicationsResponse = await dynamodb.send(applicationsCommand);
    const activeApplications: Record<string, AttributeValue>[] = applicationsResponse.Items || [];

    // Step 7: Update active applications to "job_cancelled"
    if (activeApplications.length > 0) {
      console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);
      
      const updatePromises = activeApplications.map(async (application) => {
        const applicationId = application.applicationId?.S;
        if (!applicationId) {
            console.warn("Application found without applicationId, skipping update.");
            return;
        }

        try {
          // Assuming JOB_APPLICATIONS_TABLE has a composite key of jobId (PK) and applicationId (SK)
          const updateItemCommand = new UpdateItemCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            Key: {
              jobId: { S: jobId },
              applicationId: { S: applicationId },
            },
            UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":status": { S: "job_cancelled" },
              ":updatedAt": { S: new Date().toISOString() },
            },
          });
          await dynamodb.send(updateItemCommand);
        } catch (updateError) {
          console.warn(`Failed to update application ${applicationId}:`, updateError);
        }
      });
      // Run all update promises concurrently
      await Promise.all(updatePromises);
    }

    // Step 8: Delete the job
    const deleteCommand = new DeleteItemCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        jobId: { S: jobId },
      },
    });
    await dynamodb.send(deleteCommand);

    // Step 9: Return success
    const affectedApplicationsCount = activeApplications.length;
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Permanent job deleted successfully",
        jobId,
        affectedApplications: affectedApplicationsCount,
        applicationHandling: affectedApplicationsCount > 0
          ? "Active applications have been marked as 'job_cancelled'"
          : "No active applications were affected",
      }),
    };

  } catch (error) {
    console.error("Error deleting permanent job:", error);
    // Explicitly check if the error is an instance of Error for safe property access
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
    
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to delete permanent job. Please try again.",
        details: errorMessage,
      }),
    };
  }
};