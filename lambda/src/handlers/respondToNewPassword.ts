import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    RespondToAuthChallengeCommand,
    ChallengeNameType,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface NewPasswordBody {
    email?: string;
    newPassword?: string;
    session?: string;
}

/**
 * POST /auth/respond-new-password — public.
 *
 * Completes the NEW_PASSWORD_REQUIRED challenge that loginUser.ts forwards on
 * the first sign-in for any admin-invited user (clinic team users via
 * createUser.ts, internal users via inviteTeamMember.ts). On success returns
 * the same { tokens, user } shape as /auth/login.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: NewPasswordBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { newPassword, session } = body;

        if (!email || !newPassword || !session) {
            return json(event, 400, {
                error: "Bad Request",
                message: "email, newPassword, and session are required",
            });
        }

        const resp = await cognito.send(new RespondToAuthChallengeCommand({
            ClientId: process.env.CLIENT_ID!,
            ChallengeName: ChallengeNameType.NEW_PASSWORD_REQUIRED,
            Session: session,
            ChallengeResponses: {
                USERNAME: email,
                NEW_PASSWORD: newPassword,
            },
        }));

        const tokens = resp.AuthenticationResult;
        if (!tokens) {
            // Another challenge could theoretically chain (MFA setup, etc.) but we
            // don't expect any in this user pool — surface a generic error.
            return json(event, 500, {
                error: "Internal Server Error",
                message: "Unexpected challenge response from Cognito",
            });
        }

        // Decode the access token to surface the user's groups (mirrors loginUser.ts).
        const payloadBase64 = tokens.AccessToken!.split(".")[1];
        const decoded = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));
        const sub: string = decoded.sub;
        const groups: string[] = decoded["cognito:groups"] || [];

        return json(event, 200, {
            status: "success",
            statusCode: 200,
            message: "Password set successfully",
            data: {
                tokens: {
                    accessToken: tokens.AccessToken,
                    idToken: tokens.IdToken,
                    refreshToken: tokens.RefreshToken,
                    expiresIn: tokens.ExpiresIn,
                    tokenType: tokens.TokenType || "Bearer",
                },
                user: { email, sub, groups, associatedClinics: [] },
                loginAt: new Date().toISOString(),
            },
        });
    } catch (error: any) {
        console.error("[respondToNewPassword] error:", error);
        if (error.name === "InvalidPasswordException") {
            return json(event, 400, {
                error: "Bad Request",
                message: "Password does not meet requirements (min 8 chars with upper, lower, digit, symbol).",
            });
        }
        if (error.name === "NotAuthorizedException") {
            return json(event, 401, {
                error: "Unauthorized",
                message: "This session has expired. Please sign in again.",
            });
        }
        if (error.name === "InvalidParameterException") {
            return json(event, 400, {
                error: "Bad Request",
                message: error.message || "Invalid parameters",
            });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to set new password",
        });
    }
};
