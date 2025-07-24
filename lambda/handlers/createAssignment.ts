import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface CreateAssignmentInput {
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
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can assign clinics" }) };
    }

    const { userSub, clinicId, accessLevel }: CreateAssignmentInput = JSON.parse(event.body);
    if (!userSub || !clinicId || !accessLevel) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const validAccessLevels = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
    if (!validAccessLevels.includes(accessLevel)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid access level" }) };
    }

    const command = new PutItemCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      Item: {
        userSub: { S: userSub },
        clinicId: { S: clinicId },
        accessLevel: { S: accessLevel },
        assignedAt: { S: new Date().toISOString() },
      },
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "User assigned to clinic successfully" }),
    };
  } catch (error: any) {
    console.error("Error assigning user to clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to assign user: ${error.message}` }) };
  }
};