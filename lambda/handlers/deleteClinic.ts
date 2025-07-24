import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface DeleteClinicInput {
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
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can delete clinics" }) };
    }

    const { clinicId }: DeleteClinicInput = JSON.parse(event.body);
    if (!clinicId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required" }) };
    }

    const command = new DeleteItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Key: { clinicId: { S: clinicId } },
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Clinic deleted successfully" }),
    };
  } catch (error: any) {
    console.error("Error deleting clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to delete clinic: ${error.message}` }) };
  }
};