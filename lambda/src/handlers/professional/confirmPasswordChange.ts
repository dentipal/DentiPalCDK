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
    DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand, PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

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

    // 2. Parse body — needs verificationToken (from /verify) + new password + confirm
    if (!event.body) return json(event, 400, { error: "Bad Request", message: "Request body required" });
    let verificationToken: string;
    let newPassword: string;
    let confirmPassword: string;
    try {
        const body = JSON.parse(event.body);
        verificationToken = String(body.verificationToken || "").trim();
        newPassword = body.newPassword;
        confirmPassword = body.confirmPassword;
    } catch {
        return json(event, 400, { error: "Bad Request", message: "Invalid JSON body" });
    }
    if (!verificationToken) {
        return json(event, 400, { error: "Bad Request", message: "Verification token is required" });
    }
    if (newPassword !== confirmPassword) {
        return json(event, 400, { error: "Bad Request", message: "Passwords do not match" });
    }
    const pwError = validateNewPassword(newPassword);
    if (pwError) return json(event, 400, { error: "Bad Request", message: pwError });

    try {
        // 3. Fetch OTP record — it must be VERIFIED (from /verify) and not yet USED
        const otpRes = await ddb.send(new GetCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Key: { userSub },
        }));
        const record = otpRes.Item;

        if (!record || record.purpose !== "password_change") {
            return json(event, 400, { error: "Bad Request", message: "No active verification session. Start over." });
        }
        if (!record.verified) {
            return json(event, 400, { error: "Bad Request", message: "Verification code not yet confirmed." });
        }
        if (record.used) {
            return json(event, 400, { error: "Bad Request", message: "Already changed. Start a new flow if needed." });
        }
        if (record.verificationToken !== verificationToken) {
            return json(event, 401, { error: "Unauthorized", message: "Verification token mismatch" });
        }
        const now = Math.floor(Date.now() / 1000);
        if (typeof record.verificationExpiresAt === "number" && record.verificationExpiresAt < now) {
            return json(event, 400, { error: "Bad Request", message: "Verification expired. Request a new code." });
        }

        // 4. Atomically mark as used — prevents replay if two requests fire at once.
        //    NOTE: At this point the user has fully consented. If the network
        //    fails AFTER this update, the password may still get changed by
        //    the subsequent calls. If everything fails, the previous password
        //    is preserved (because we haven't called AdminSetUserPassword yet).
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
            throw new Error("Already changed. Start a new flow if needed.");
        });

        // 5. Resolve email for Cognito calls
        let email = tokenEmail;
        if (!email) {
            const user = await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: userSub,
            }));
            email = user.UserAttributes?.find(a => a.Name === "email")?.Value;
        }

        // 6. Set the new password (permanent, not a temporary "force change")
        await cognito.send(new AdminSetUserPasswordCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: userSub,
            Password: newPassword,
            Permanent: true,
        }));

        // 7. Sign out everywhere (invalidates all refresh tokens on every device)
        await cognito.send(new AdminUserGlobalSignOutCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: userSub,
        }));

        // 7b. Write to the session-invalidation denylist so existing ACCESS
        //     tokens (which Cognito does NOT revoke) are rejected by the
        //     router on their next request. invalidatedBefore is "now"; any
        //     token issued before this moment is dead on its next API call.
        //     We use a 31-day ttl so rows auto-clean after refresh tokens
        //     would have expired anyway.
        // Use "now - 1s" so a token issued in the same second as this write
        // still passes (`iat < invalidatedBefore` is the check). Eliminates
        // a 1-in-1 chance of locking out the current device.
        const invalidatedBefore = Math.floor(Date.now() / 1000) - 1;
        if (process.env.SESSION_INVALIDATIONS_TABLE) {
            try {
                await ddb.send(new PutCommand({
                    TableName: process.env.SESSION_INVALIDATIONS_TABLE,
                    Item: {
                        userSub,
                        invalidatedBefore,
                        reason: "password_change",
                        invalidatedAt: new Date().toISOString(),
                        ttl: invalidatedBefore + 31 * 24 * 60 * 60,   // 31 days
                    },
                }));
            } catch (e) {
                console.error("Failed to write session invalidation", e);
                // Not fatal — refresh-token invalidation still works.
            }
        }

        // 8. Re-issue tokens so the current device stays logged in.
        //    NOTE: This MUST come after step 7b so the new token's `iat`
        //    is >= invalidatedBefore, otherwise the router would reject
        //    the current device's very next request.
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

        // 9. Clean up the OTP row
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
