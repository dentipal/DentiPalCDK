import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const corsHeaders: { [key: string]: string } = {
  "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

export const handler = async (event: any): Promise<any> => {
  try {
    // Step 1: Get userSub from JWT token
    const userSub = await validateToken(event);

    // Step 2: Check if userSub is valid
    if (!userSub) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized - Invalid or expired token" }),
      };
    }

    // Step 3: Check if the user has a profile
    const getParams = {
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      Key: {
        userSub: { S: userSub },
      },
    };
    const existingProfile = await dynamodb.send(new GetItemCommand(getParams));

    if (!existingProfile.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Professional profile not found" }),
      };
    }

    // Step 4: Check if the profile is the default profile
    // DynamoDB attribute may come back as { BOOL: true } or { S: 'true' }
    const isDefaultAttr = existingProfile.Item.isDefault as any;
    const isDefault = !!(
      isDefaultAttr && ((isDefaultAttr.BOOL === true) || (isDefaultAttr.S === "true"))
    );

    if (isDefault) {
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Cannot delete default profile. Set another profile as default first.",
        }),
      };
    }

    // Step 5: Delete the professional profile
    const deleteParams = {
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      Key: {
        userSub: { S: userSub },
      },
    };
    await dynamodb.send(new DeleteItemCommand(deleteParams));

    // Step 6: Return success response
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Professional profile deleted successfully",
        userSub,
        deletedAt: new Date().toISOString(),
      }),
    };
  } catch (error: any) {
    console.error("Error deleting professional profile:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: error?.message ?? String(error) }),
    };
  }
};

export default handler;
