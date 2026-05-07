import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    ConfirmSignUpCommand,
    AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface VerifyBody {
    email?: string;
    confirmationCode?: string;
}

/**
 * POST /admin/auth/verify-bootstrap-otp — public.
 *
 * Confirms the SignUp from /admin/auth/bootstrap-admin and promotes the user
 * to the Admin Cognito group. The single-shot bootstrap gate has been removed
 * — additional admins can register via /admin/signup at any time.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: VerifyBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const confirmationCode = (body.confirmationCode || "").trim();

        if (!email || !confirmationCode) {
            return json(event, 400, {
                error: "Bad Request",
                message: "email and confirmationCode are required",
            });
        }

        // Confirm the OTP. After this the user is CONFIRMED but not yet in any group.
        try {
            await cognito.send(new ConfirmSignUpCommand({
                ClientId: process.env.CLIENT_ID!,
                Username: email,
                ConfirmationCode: confirmationCode,
            }));
        } catch (err: any) {
            if (err.name === "CodeMismatchException") {
                return json(event, 400, { error: "Bad Request", message: "Invalid verification code." });
            }
            if (err.name === "ExpiredCodeException") {
                return json(event, 400, { error: "Bad Request", message: "Verification code has expired. Please request a new one." });
            }
            if (err.name === "UserNotFoundException") {
                return json(event, 404, { error: "Not Found", message: "No pending signup for this email." });
            }
            if (err.name === "NotAuthorizedException") {
                // Cognito returns this if the user is already CONFIRMED. Treat as
                // idempotent — fall through to the group-add step.
                console.log("[verifyAdminBootstrap] NotAuthorizedException — user may already be confirmed, continuing");
            } else {
                throw err;
            }
        }

        await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: email,
            GroupName: "Admin",
        }));

        return json(event, 200, {
            status: "success",
            message: "Admin account verified. Please sign in.",
        });
    } catch (error: any) {
        console.error("[verifyAdminBootstrap] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to verify admin signup",
        });
    }
};
