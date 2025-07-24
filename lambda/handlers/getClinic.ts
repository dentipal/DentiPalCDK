import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { isRoot, hasClinicAccess } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface GetClinicInput {
  clinicId: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    const userSub = event.requestContext.authorizer.claims.sub;
    const { clinicId }: GetClinicInput = JSON.parse(event.body);
    if (!clinicId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required" }) };
    }

    if (!isRoot(groups) && !(await hasClinicAccess(userSub, clinicId))) {
      return { statusCode: 403, body: JSON.stringify({ error: "Access denied to clinic" }) };
    }

    const command = new GetItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Key: { clinicId: { S: clinicId } },
    });
    const response = await dynamoClient.send(command);
    if (!response.Item) {
      return { statusCode: 404, body: JSON.stringify({ error: "Clinic not found" }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        clinic: {
          clinicId: response.Item.clinicId.S,
          name: response.Item.name.S,
          address: response.Item.address.S,
          createdBy: response.Item.createdBy.S,
          createdAt: response.Item.createdAt.S,
          updatedAt: response.Item.updatedAt.S,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve clinic: ${error.message}` }) };
  }
};