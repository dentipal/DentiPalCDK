import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { buildAddress, isRoot, hasClinicAccess } from "./utils";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

interface UpdateClinicInput {
  clinicId: string;
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

interface LambdaResponse {
  statusCode: number;
  body: string;
}

export const handler = async (event: any): Promise<LambdaResponse> => {
  try {
    const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
    const userSub = event.requestContext.authorizer.claims.sub;
    const { clinicId, name, addressLine1, addressLine2, addressLine3, city, state, pincode }: UpdateClinicInput = JSON.parse(event.body);
    if (!clinicId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required" }) };
    }

    if (!isRoot(groups) && !(await hasClinicAccess(userSub, clinicId, 'ClinicAdmin'))) {
      return { statusCode: 403, body: JSON.stringify({ error: "Access denied to update clinic" }) };
    }

    const updateExpression: string[] = [];
    const expressionAttributeValues: { [key: string]: any } = {};
    if (name) {
      updateExpression.push("name = :name");
      expressionAttributeValues[":name"] = { S: name };
    }
    if (addressLine1 || city || state || pincode) {
      const address = buildAddress({ addressLine1: addressLine1 || "", addressLine2, addressLine3, city: city || "", state: state || "", pincode: pincode || "" });
      updateExpression.push("address = :address");
      expressionAttributeValues[":address"] = { S: address };
    }
    updateExpression.push("updatedAt = :updatedAt");
    expressionAttributeValues[":updatedAt"] = { S: new Date().toISOString() };
    if (updateExpression.length === 1) {
      return { statusCode: 400, body: JSON.stringify({ error: "No fields to update" }) };
    }

    const command = new UpdateItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Key: { clinicId: { S: clinicId } },
      UpdateExpression: `SET ${updateExpression.join(", ")}`,
      ExpressionAttributeValues: expressionAttributeValues,
    });
    await dynamoClient.send(command);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Clinic updated successfully" }),
    };
  } catch (error: any) {
    console.error("Error updating clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to update clinic: ${error.message}` }) };
  }
};