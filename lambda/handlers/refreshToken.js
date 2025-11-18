"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");
const cognito = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        const tokenData = JSON.parse(event.body);
        // Validate required fields
        if (!tokenData.refreshToken) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Required field: refreshToken"
                })
            };
        }
        // Refresh tokens with Cognito
        const refreshCommand = new client_cognito_identity_provider_1.InitiateAuthCommand({
            ClientId: process.env.CLIENT_ID,
            AuthFlow: client_cognito_identity_provider_1.AuthFlowType.REFRESH_TOKEN_AUTH,
            AuthParameters: {
                REFRESH_TOKEN: tokenData.refreshToken,
            },
        });
        const refreshResponse = await cognito.send(refreshCommand);
        // Check if refresh was successful
        if (!refreshResponse.AuthenticationResult) {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    error: "Token refresh failed. Please login again."
                })
            };
        }
        const tokens = refreshResponse.AuthenticationResult;
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Tokens refreshed successfully",
                tokens: {
                    accessToken: tokens.AccessToken,
                    idToken: tokens.IdToken,
                    // Note: Refresh token might not be returned in refresh flow, original one is still valid
                    refreshToken: tokens.RefreshToken || tokenData.refreshToken,
                    expiresIn: tokens.ExpiresIn, // Time in seconds until new access token expires
                    tokenType: tokens.TokenType || "Bearer"
                }
            })
        };
    }
    catch (error) {
        console.error("Error during token refresh:", error);
        // Handle specific Cognito errors
        if (error.name === 'NotAuthorizedException') {
            return {
                statusCode: 401,
                body: JSON.stringify({
                    error: "Invalid refresh token. Please login again."
                })
            };
        }
        if (error.name === 'UserNotFoundException') {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "User not found. Please login again."
                })
            };
        }
        if (error.name === 'TooManyRequestsException') {
            return {
                statusCode: 429,
                body: JSON.stringify({
                    error: "Too many requests. Please try again later."
                })
            };
        }
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Token refresh failed. Please try again.",
                details: error.message
            })
        };
    }
};
exports.handler = handler;
