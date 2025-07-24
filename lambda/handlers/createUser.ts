import { CognitoIdentityProviderClient, SignUpCommand, AdminAddUserToGroupCommand } from "@aws-sdk/client-cognito-identity-provider";
import { buildAddress, isRoot } from "./utils";

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });

interface CreateUserInput {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  state: string;
  pincode: string;
  email: string;
  password: string;
  verifyPassword: string;
  group: string;
  subgroup: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can create users" }) };
    }

    const body: CreateUserInput = JSON.parse(event.body);
    const { firstName, lastName, phoneNumber, addressLine1, addressLine2, addressLine3, city, state, pincode, email, password, verifyPassword, group, subgroup } = body;

    if (password !== verifyPassword) {
      return { statusCode: 400, body: JSON.stringify({ error: "Passwords do not match" }) };
    }
    if (!firstName || !lastName || !phoneNumber || !addressLine1 || !city || !state || !pincode || !email || !password || !group || !subgroup) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const validGroups = ['Clinic Employees', 'Professionals'];
    const validSubgroups: { [key: string]: string[] } = {
      'Clinic Employees': ['ClinicAdmin', 'ClinicManager', 'ClinicViewer'],
      'Professionals': ['Front Desk', 'Dental Assistant', 'Front Desk/DA', 'Hygienist', 'Dentist']
    };
    if (!validGroups.includes(group) || !validSubgroups[group].includes(subgroup)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid group or subgroup" }) };
    }

    const address = buildAddress({ addressLine1, addressLine2, addressLine3, city, state, pincode });
    const signUpCommand = new SignUpCommand({
      ClientId: process.env.CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "given_name", Value: firstName },
        { Name: "family_name", Value: lastName },
        { Name: "phone_number", Value: phoneNumber },
        { Name: "email", Value: email },
        { Name: "address", Value: address },
      ],
    });
    const signUpResponse = await cognitoClient.send(signUpCommand);
    const addToGroupCommand = new AdminAddUserToGroupCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      GroupName: `${group}:${subgroup}`,
    });
    await cognitoClient.send(addToGroupCommand);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "User created successfully", userSub: signUpResponse.UserSub }),
    };
  } catch (error: any) {
    console.error("Error creating user:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to create user: ${error.message}` }) };
  }
};