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
        return json(400, { error: "Request body is missing" });
      }
      tokenData = JSON.parse(event.body) as TokenData;
    } catch (parseError) {
      return json(400, { error: "Invalid JSON format in request body" });
    }

    // Validate required field
    if (!tokenData.refreshToken) {
      return json(400, { error: "Required field: refreshToken" });
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
        error: "Token refresh failed or tokens missing in response. Please login again."
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
      message: "Tokens refreshed successfully",
      tokens: responseBody
    });

  } catch (error: any) {
    console.error("Error during token refresh:", error);

    const errorName = error.name;

    // 5. Handle specific Cognito errors
    if (errorName === 'NotAuthorizedException') {
      return json(401, { error: "Invalid refresh token. Please login again." });
    }
    if (errorName === 'UserNotFoundException') {
      return json(404, { error: "User not found. Please login again." });
    }
    if (errorName === 'TooManyRequestsException') {
      return json(429, { error: "Too many requests. Please try again later." });
    }

    // 6. Generic/Unhandled Error Response
    return json(500, {
      error: "Token refresh failed. Please try again.",
      details: error.message || "An unknown error occurred"
    });
  }
};