import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AuthFlowType,
  AuthenticationResultType,
  InitiateAuthCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2
} from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions for better safety ---

/** Defines the expected structure of the request body (the JSON payload). */
interface TokenData {
  refreshToken: string;
}

/** Defines the structure of the successful response tokens payload. */
interface RefreshedTokens {
  accessToken: string;
  idToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

/** Defines the standard Lambda/API Gateway response structure. */
// FIX: Extend APIGatewayProxyStructuredResultV2 instead of the Union type APIGatewayProxyResultV2
interface HandlerResponse extends APIGatewayProxyStructuredResultV2 {
  statusCode: number;
  body: string; // The body is always a stringified JSON object
}

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): HandlerResponse => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

// --- Initialize AWS SDK Client ---

// Use null assertion (!) here as we expect this environment variable to be set in a Lambda context.
const REGION = process.env.REGION!;
const CLIENT_ID = process.env.CLIENT_ID!;

const cognito = new CognitoIdentityProviderClient({ region: REGION });

// --- Handler Function ---

/**
 * AWS Lambda handler function to refresh Cognito tokens.
 * @param event The API Gateway Proxy event.
 * @returns A promise resolving to an API Gateway Proxy result (HandlerResponse).
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
  // CORS Preflight (V2 events usually handle CORS in API Gateway, but adding here for consistency)
  if (event.requestContext.http.method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // 1. Parse and Validate Input
    let tokenData: TokenData;

    try {
      // Event body can be undefined or null in some Lambda event types (e.g., S3, SNS).
      // For an API Gateway V2 proxy integration, we expect it to be a string.
      if (!event.body) {
        return json(400, {
          error: "Bad Request",
          statusCode: 400,
          message: "Request body is missing",
          details: { issue: "JSON body is required" },
          timestamp: new Date().toISOString()
        });
      }
      tokenData = JSON.parse(event.body) as TokenData;
    } catch (parseError) {
      return json(400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Invalid JSON format in request body",
        details: { issue: "Body must be valid JSON" },
        timestamp: new Date().toISOString()
      });
    }

    // Validate required field
    if (!tokenData.refreshToken) {
      return json(400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Refresh token is required",
        details: { missingFields: ["refreshToken"] },
        timestamp: new Date().toISOString()
      });
    }

    // 2. Refresh tokens with Cognito
    const refreshCommand = new InitiateAuthCommand({
      ClientId: CLIENT_ID,
      AuthFlow: AuthFlowType.REFRESH_TOKEN_AUTH,
      AuthParameters: {
        REFRESH_TOKEN: tokenData.refreshToken,
      },
    });

    // The send call's return type is strongly typed as InitiateAuthCommandOutput
    const refreshResponse: InitiateAuthCommandOutput = await cognito.send(refreshCommand);

    // 3. Check for successful authentication result
    const tokens: AuthenticationResultType | undefined = refreshResponse.AuthenticationResult;

    if (!tokens || !tokens.AccessToken || !tokens.IdToken) {
      // This case might capture various issues like token expiration or client misconfig
      return json(401, {
        error: "Unauthorized",
        statusCode: 401,
        message: "Token refresh failed",
        details: { issue: "Invalid refresh token or tokens missing in response. Please login again." },
        timestamp: new Date().toISOString()
      });
    }

    // 4. Successful Response
    const responseBody: RefreshedTokens = {
      accessToken: tokens.AccessToken,
      idToken: tokens.IdToken,
      // The InitiateAuth command may or may not return a new RefreshToken.
      // We default to the one passed in the request if a new one isn't provided.
      refreshToken: tokens.RefreshToken || tokenData.refreshToken,
      expiresIn: tokens.ExpiresIn || 3600, // Default to 1 hour if not specified
      tokenType: tokens.TokenType || "Bearer"
    };

    return json(200, {
      status: "success",
      statusCode: 200,
      message: "Tokens refreshed successfully",
      data: responseBody,
      timestamp: new Date().toISOString()
    });

  } catch (error: any) {
    console.error("Error during token refresh:", error);

    const errorName = error.name;
    let statusCode = 500;
    let message = "Token refresh failed";
    let details: Record<string, any> = { errorType: errorName, reason: error.message };

    // 5. Handle specific Cognito errors
    if (errorName === 'NotAuthorizedException') {
      statusCode = 401;
      message = "Invalid refresh token";
      details.suggestion = "Please login again to obtain a new refresh token";
    } else if (errorName === 'UserNotFoundException') {
      statusCode = 404;
      message = "User not found";
      details.suggestion = "Please login again";
    } else if (errorName === 'TooManyRequestsException') {
      statusCode = 429;
      message = "Too many requests";
      details.suggestion = "Please try again later";
    } else if (errorName === 'InvalidParameterException') {
      statusCode = 400;
      message = "Invalid parameters";
      details.suggestion = "Check your refresh token format";
    }

    // 6. Generic/Unhandled Error Response
    const errorTypeMap: Record<number, string> = {
      400: "Bad Request",
      401: "Unauthorized",
      404: "Not Found",
      429: "Too Many Requests",
      500: "Internal Server Error"
    };

    return json(statusCode, {
      error: errorTypeMap[statusCode],
      statusCode: statusCode,
      message: message,
      details: details,
      timestamp: new Date().toISOString()
    });
  }
};