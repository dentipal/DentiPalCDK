import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import { isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface GetAssignmentsInput {
  userSub?: string;
}

interface Assignment {
  userSub: string;
  clinicId: string;
  accessLevel: string;
  assignedAt: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const userSub = event.requestContext.authorizer.claims.sub;
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    const { userSub: queryUserSub }: GetAssignmentsInput = JSON.parse(event.body) || {};
    const targetUserSub = isRoot(groups) && queryUserSub ? queryUserSub : userSub;

    const command = new QueryCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: { ":userSub": { S: targetUserSub } },
    });
    const response = await dynamoClient.send(command);
    const assignments: Assignment[] = (response.Items || []).map(item => ({
      userSub: item.userSub.S!,
      clinicId: item.clinicId.S!,
      accessLevel: item.accessLevel.S!,
      assignedAt: item.assignedAt.S!,
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", assignments }),
    };
  } catch (error: any) {
    console.error("Error retrieving assignments:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve assignments: ${error.message}` }) };
  }
};