import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    ResendConfirmationCodeCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/**
 * POST /admin/auth/resend-bootstrap-otp — public.
 *
 * Resends the OTP for an in-flight bootstrap signup. Still gated by the
 * single-shot rule so it can't be used to spam a fully-bootstrapped tenant.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const { email: rawEmail } = JSON.parse(event.body) as { email?: string };
        const email = (rawEmail || "").toLowerCase().trim();
        if (!email) {
            return json(event, 400, { error: "Bad Request", message: "email is required" });
        }

        await cognito.send(new ResendConfirmationCodeCommand({
            ClientId: process.env.CLIENT_ID!,
            Username: email,
        }));

        return json(event, 200, {
            status: "success",
            message: "Verification code re-sent. Please check your email.",
        });
    } catch (error: any) {
        console.error("[resendAdminBootstrapOtp] error:", error);
        if (error.name === "UserNotFoundException") {
            return json(event, 404, { error: "Not Found", message: "No pending signup for this email." });
        }
        if (error.name === "InvalidParameterException" && /already confirmed/i.test(error.message || "")) {
            return json(event, 400, { error: "Bad Request", message: "This account is already verified. Please sign in." });
        }
        if (error.name === "LimitExceededException") {
            return json(event, 429, { error: "Too Many Requests", message: "Please wait before requesting another code." });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to resend verification code",
        });
    }
};
