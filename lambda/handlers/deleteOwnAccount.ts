import { CognitoIdentityProviderClient, DeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, QueryCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const userSub = event.requestContext.authorizer?.claims.sub;
    const accessToken = event.headers.Authorization?.split(' ')[1];
    if (!accessToken) {
      return { statusCode: 400, body: JSON.stringify({ error: "Access token is required" }) };
    }
    if (!userSub) {
      return { statusCode: 400, body: JSON.stringify({ error: "UserSub is required" }) };
    }

    // Clean up assignments
    const cleanupCommand = new QueryCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: { ":userSub": { S: userSub } },
    });
    const assignments = await dynamoClient.send(cleanupCommand);
    for (const item of assignments.Items || []) {
      if (item.clinicId?.S) { // Ensure clinicId.S is defined
        await dynamoClient.send(new DeleteItemCommand({
          TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
          Key: {
            userSub: { S: userSub },
            clinicId: { S: item.clinicId.S },
          },
        }));
      }
    }

    const command = new DeleteUserCommand({ AccessToken: accessToken });
    await cognitoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Account deleted successfully" }),
    };
  } catch (error: any) {
    console.error("Error deleting account:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to delete account: ${error.message}` }) };
  }
};