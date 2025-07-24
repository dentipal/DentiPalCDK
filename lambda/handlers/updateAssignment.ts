import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface UpdateAssignmentInput {
  userSub: string;
  clinicId: string;
  accessLevel: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can update assignments" }) };
    }

    const { userSub, clinicId, accessLevel }: UpdateAssignmentInput = JSON.parse(event.body);
    if (!userSub || !clinicId || !accessLevel) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const validAccessLevels = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
    if (!validAccessLevels.includes(accessLevel)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid access level" }) };
    }

    const command = new UpdateItemCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      Key: { userSub: { S: userSub }, clinicId: { S: clinicId } },
      UpdateExpression: "SET accessLevel = :accessLevel, assignedAt = :assignedAt",
      ExpressionAttributeValues: {
        ":accessLevel": { S: accessLevel },
        ":assignedAt": { S: new Date().toISOString() },
      },
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Assignment updated successfully" }),
    };
  } catch (error: any) {
    console.error("Error updating assignment:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to update assignment: ${error.message}` }) };
  }
};