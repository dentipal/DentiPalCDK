import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { isRoot } from "./utils";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });

interface DeleteUserInput {
  username: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can delete other users" }) };
    }

    const { username }: DeleteUserInput = JSON.parse(event.body);
    if (!username) {
      return { statusCode: 400, body: JSON.stringify({ error: "Username (email) is required" }) };
    }

    const command = new AdminDeleteUserCommand({ UserPoolId: process.env.USER_POOL_ID, Username: username });
    await cognitoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "User deleted successfully" }),
    };
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to delete user: ${error.message}` }) };
  }
};