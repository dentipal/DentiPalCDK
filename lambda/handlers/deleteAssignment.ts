import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface DeleteAssignmentInput {
  userSub: string;
  clinicId: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can delete assignments" }) };
    }

    const { userSub, clinicId }: DeleteAssignmentInput = JSON.parse(event.body);
    if (!userSub || !clinicId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const command = new DeleteItemCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      Key: {
        userSub: { S: userSub },
        clinicId: { S: clinicId },
      },
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Assignment deleted successfully" }),
    };
  } catch (error: any) {
    console.error("Error deleting assignment:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to delete assignment: ${error.message}` }) };
  }
};