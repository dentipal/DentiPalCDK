import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from "@aws-sdk/client-cognito-identity-provider";
import { buildAddress, isRoot } from "./utils";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });

interface UpdateUserInput {
  username: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  city?: string;
  state?: string;
  pincode?: string;
  email?: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can update user details" }) };
    }

    const { username, firstName, lastName, phoneNumber, addressLine1, addressLine2, addressLine3, city, state, pincode, email }: UpdateUserInput = JSON.parse(event.body);
    if (!username) {
      return { statusCode: 400, body: JSON.stringify({ error: "Username (email) is required" }) };
    }

    const attributes: { Name: string; Value: string }[] = [];
    if (firstName) attributes.push({ Name: "given_name", Value: firstName });
    if (lastName) attributes.push({ Name: "family_name", Value: lastName });
    if (phoneNumber) attributes.push({ Name: "phone_number", Value: phoneNumber });
    if (email) attributes.push({ Name: "email", Value: email });
    if (addressLine1 || city || state || pincode) {
      const address = buildAddress({ addressLine1: addressLine1 || "", addressLine2, addressLine3, city: city || "", state: state || "", pincode: pincode || "" });
      attributes.push({ Name: "address", Value: address });
    }
    if (attributes.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "No attributes to update" }) };
    }

    const command = new AdminUpdateUserAttributesCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: username,
      UserAttributes: attributes,
    });
    await cognitoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "User updated successfully" }),
    };
  } catch (error: any) {
    console.error("Error updating user:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to update user: ${error.message}` }) };
  }
};