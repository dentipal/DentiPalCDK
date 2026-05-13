import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    AdminSetUserPasswordCommand,
    AdminUserGlobalSignOutCommand,
    AdminInitiateAuthCommand,
    AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const OTP_MAX_ATTEMPTS = 5;

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// Cognito's password policy: min 8, upper, lower, digit, symbol.
const validateNewPassword = (pw: string): string | null => {
    if (!pw || pw.length < 8) return "Password must be at least 8 characters";
    if (!/[A-Z]/.test(pw)) return "Password must contain an uppercase letter";
    if (!/[a-z]/.test(pw)) return "Password must contain a lowercase letter";
    if (!/[0-9]/.test(pw)) return "Password must contain a digit";
    if (!/[^A-Za-z0-9]/.test(pw)) return "Password must contain a symbol";
    return null;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    // 1. Authenticate
    let userSub: string;
    let tokenEmail: string | undefined;
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const info = extractUserFromBearerToken(authHeader);
        userSub = info.sub;
        tokenEmail = info.email;
    } catch (err: any) {
        return json(event, 401, { error: "Unauthorized", message: err.message || "Invalid token" });
    }

    // 2. Parse body
    if (!event.body) return json(event, 400, { error: "Bad Request", message: "Request body required" });
    let otpInput: string;
    let newPassword: string;
    try {
        const body = JSON.parse(event.body);
        otpInput = String(body.otp || "").trim();
        newPassword = body.newPassword;
    } catch {
        return json(event, 400, { error: "Bad Request", message: "Invalid JSON body" });
    }
    if (!otpInput || !/^\d{6}$/.test(otpInput)) {
        return json(event, 400, { error: "Bad Request", message: "OTP must be 6 digits" });
    }
    const pwError = validateNewPassword(newPassword);
    if (pwError) return json(event, 400, { error: "Bad Request", message: pwError });

    try {
        // 3. Fetch OTP record
        const otpRes = await ddb.send(new GetCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Key: { userSub },
        }));
        const record = otpRes.Item;

        if (!record || record.purpose !== "password_change") {
            return json(event, 400, { error: "Bad Request", message: "No active verification code. Request a new one." });
        }
        if (record.used) {
            return json(event, 400, { error: "Bad Request", message: "Verification code already used. Request a new one." });
        }
        const now = Math.floor(Date.now() / 1000);
        if (typeof record.expiresAt === "number" && record.expiresAt < now) {
            return json(event, 400, { error: "Bad Request", message: "Verification code expired. Request a new one." });
        }
        if ((record.attempts || 0) >= OTP_MAX_ATTEMPTS) {
            return json(event, 429, { error: "Too Many Requests", message: "Too many invalid attempts. Request a new code." });
        }

        // 4. Compare OTP
        if (record.otp !== otpInput) {
            await ddb.send(new UpdateCommand({
                TableName: process.env.PASSWORD_OTP_TABLE!,
                Key: { userSub },
                UpdateExpression: "SET attempts = if_not_exists(attempts, :zero) + :one",
                ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
            }));
            return json(event, 401, { error: "Unauthorized", message: "Incorrect verification code" });
        }

        // 5. Mark OTP as used BEFORE changing the password — prevents
        //    a race where two requests with the same OTP both succeed.
        await ddb.send(new UpdateCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Key: { userSub },
            UpdateExpression: "SET used = :t, usedAt = :now",
            ConditionExpression: "attribute_not_exists(used) OR used = :f",
            ExpressionAttributeValues: {
                ":t": true,
                ":f": false,
                ":now": new Date().toISOString(),
            },
        })).catch(() => {
            // ConditionalCheckFailed means another request already used it
            throw new Error("Verification code already used. Request a new one.");
        });

        // 6. Resolve the user's email for the Cognito calls below
        let email = tokenEmail;
        if (!email) {
            const user = await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: userSub,
            }));
            email = user.UserAttributes?.find(a => a.Name === "email")?.Value;
        }

        // 7. Set the new password (permanent, not a temporary "force change")
        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: userSub,
            Password: newPassword,
            Permanent: true,
        }));

        // 8. Sign out everywhere (invalidates all refresh tokens on every device)
        await cognito.send(new AdminUserGlobalSignOutCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: userSub,
        }));

        // 9. Re-issue tokens for the current session (so the user stays
        //    logged in on the device where they changed the password).
        //    Frontend swaps these tokens into storage on success.
        let newTokens: any = null;
        if (email) {
            try {
                const auth = await cognito.send(new AdminInitiateAuthCommand({
                    UserPoolId: process.env.USER_POOL_ID!,
                    ClientId: process.env.CLIENT_ID!,
                    AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
                    AuthParameters: {
                        USERNAME: email,
                        PASSWORD: newPassword,
                    },
                }));
                newTokens = {
                    accessToken: auth.AuthenticationResult?.AccessToken,
                    idToken: auth.AuthenticationResult?.IdToken,
                    refreshToken: auth.AuthenticationResult?.RefreshToken,
                    expiresIn: auth.AuthenticationResult?.ExpiresIn,
                };
            } catch (e) {
                console.warn("Re-auth after password change failed", e);
            }
        }

        // 10. Clean up the OTP row
        await ddb.send(new DeleteCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Key: { userSub },
        })).catch(() => { /* not fatal — TTL will reap it */ });

        return json(event, 200, {
            status: "success",
            message: "Password changed. You have been signed out on other devices.",
            data: { tokens: newTokens },
        });
    } catch (err: any) {
        console.error("confirmPasswordChange failed", err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: err.message || "Failed to change password",
        });
    }
};
