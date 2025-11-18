"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient
} = require("@aws-sdk/client-cognito-identity-provider");

const {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand
} = require("@aws-sdk/client-dynamodb");

const { validateToken } = require("./utils"); // ✅ Import your token utility

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
  try {
    // ✅ Get userSub using shared token validator
    const userSub = await validateToken(event);
    if (!userSub) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "UserSub is required" })
      };
    }

    // 🧹 Clean up clinic assignments
    const cleanupCommand = new QueryCommand({
      TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: {
        ":userSub": { S: userSub }
      }
    });

    const assignments = await dynamoClient.send(cleanupCommand);
    for (const item of assignments.Items || []) {
      if (item.clinicId?.S) {
        await dynamoClient.send(new DeleteItemCommand({
          TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
          Key: {
            userSub: { S: userSub },
            clinicId: { S: item.clinicId.S }
          }
        }));
      }
    }

    // ❌ Stop using accessToken
    // ✅ Use AdminDeleteUserCommand with userSub
    await cognitoClient.send(new AdminDeleteUserCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: userSub
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        status: "success",
        message: "Account deleted successfully"
      })
    };

  } catch (error) {
    console.error("Error deleting account:", error);
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: `Failed to delete account: ${error.message}`
      })
    };
  }
};

exports.handler = handler;
