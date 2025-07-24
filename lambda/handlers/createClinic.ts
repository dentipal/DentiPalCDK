import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { buildAddress, isRoot } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface CreateClinicInput {
  name: string;
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  state: string;
  pincode: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    if (!isRoot(groups)) {
      return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can create clinics" }) };
    }

    const { name, addressLine1, addressLine2, addressLine3, city, state, pincode }: CreateClinicInput = JSON.parse(event.body);
    if (!name || !addressLine1 || !city || !state || !pincode) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
    }

    const address = buildAddress({ addressLine1, addressLine2, addressLine3, city, state, pincode });
    const clinicId = uuidv4();
    const timestamp = new Date().toISOString();
    const userSub = event.requestContext.authorizer.claims.sub;

    const command = new PutItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Item: {
        clinicId: { S: clinicId },
        name: { S: name },
        address: { S: address },
        createdBy: { S: userSub },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
      },
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Clinic created successfully", clinicId }),
    };
  } catch (error: any) {
    console.error("Error creating clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to create clinic: ${error.message}` }) };
  }
};