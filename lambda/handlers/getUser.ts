import { CognitoIdentityProviderClient, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { isRoot } from "./utils";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });

interface GetUserInput {
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
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can read user details" }) };
    }

    const { username }: GetUserInput = JSON.parse(event.body);
    if (!username) {
      return { statusCode: 400, body: JSON.stringify({ error: "Username (email) is required" }) };
    }

    const command = new AdminGetUserCommand({ UserPoolId: process.env.USER_POOL_ID, Username: username });
    const response = await cognitoClient.send(command);
    const attributes = response.UserAttributes?.reduce((acc: { [key: string]: string }, attr) => {
      acc[attr.Name!] = attr.Value!;
      return acc;
    }, {}) || {};

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        user: {
          username: response.Username,
          firstName: attributes.given_name,
          lastName: attributes.family_name,
          phoneNumber: attributes.phone_number,
          email: attributes.email,
          address: attributes.address,
          enabled: response.Enabled,
          userStatus: response.UserStatus,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving user:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve user: ${error.message}` }) };
  }
};