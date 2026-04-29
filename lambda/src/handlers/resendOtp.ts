import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  ResendConfirmationCodeCommand,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    if (!event.body) {
      return json(event, 400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Request body is missing",
        details: { issue: "JSON body is required" },
        timestamp: new Date().toISOString(),
      });
    }

    const { email: rawEmail } = JSON.parse(event.body) as { email?: string };

    if (!rawEmail) {
      return json(event, 400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Email is required",
        timestamp: new Date().toISOString(),
      });
    }

    const email = rawEmail.toLowerCase();

    // Confirm the user exists and is actually waiting on OTP verification
    let userStatus: string | undefined;
    try {
      const existing = await cognito.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: email,
        })
      );
      userStatus = existing.UserStatus;
    } catch (err: any) {
      if (err.name === "UserNotFoundException") {
        return json(event, 404, {
          error: "Not Found",
          statusCode: 404,
          message: "No signup found for this email",
          details: { suggestion: "Start registration via /auth/initiate-registration" },
          timestamp: new Date().toISOString(),
        });
      }
      throw err;
    }

    if (userStatus === "CONFIRMED") {
      return json(event, 409, {
        error: "Conflict",
        statusCode: 409,
        message: "Email is already verified",
        details: { suggestion: "Please sign in instead" },
        timestamp: new Date().toISOString(),
      });
    }

    if (userStatus !== "UNCONFIRMED") {
      return json(event, 409, {
        error: "Conflict",
        statusCode: 409,
        message: `Cannot resend code — user is in '${userStatus}' state`,
        timestamp: new Date().toISOString(),
      });
    }

    const result = await cognito.send(
      new ResendConfirmationCodeCommand({
        ClientId: process.env.CLIENT_ID,
        Username: email,
      })
    );

    return json(event, 200, {
      status: "success",
      statusCode: 200,
      message: "Verification code resent. Please check your email.",
      data: {
        email,
        codeDeliveryDetails: result.CodeDeliveryDetails,
        nextStep: "Submit the code to /auth/verify-otp",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Error resending confirmation code:", error);

    let statusCode = 500;
    let message = "Failed to resend verification code";
    const details: Record<string, any> = { errorType: error.name, reason: error.message };

    if (error.name === "LimitExceededException" || error.name === "TooManyRequestsException") {
      statusCode = 429;
      message = "Too many requests. Please wait a moment and try again.";
    } else if (error.name === "InvalidParameterException") {
      statusCode = 400;
      message = "Invalid email";
    }

    return json(event, statusCode, {
      error:
        statusCode === 400 ? "Bad Request" :
        statusCode === 429 ? "Too Many Requests" :
        "Internal Server Error",
      statusCode,
      message,
      details,
      timestamp: new Date().toISOString(),
    });
  }
};
