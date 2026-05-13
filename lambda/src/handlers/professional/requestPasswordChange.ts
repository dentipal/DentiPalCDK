import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";
import { sendNotificationEmail } from "../sendNotificationEmail";

const REGION = process.env.REGION || "us-east-1";
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const OTP_TTL_SECONDS = 10 * 60;       // 10 minutes
const OTP_MAX_ATTEMPTS = 5;

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

const generateOtp = () => String(Math.floor(100000 + Math.random() * 900000));

const maskEmail = (email: string) => {
    const [local, domain] = email.split("@");
    if (!local || !domain) return email;
    const visible = local.slice(0, Math.min(2, local.length));
    return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    // 1. Authenticate (user must already be logged in)
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

    try {
        // 2. Resolve the user's email (prefer JWT, fall back to Cognito lookup)
        let email = tokenEmail;
        if (!email) {
            const user = await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: userSub,
            }));
            email = user.UserAttributes?.find(a => a.Name === "email")?.Value;
        }
        if (!email) {
            return json(event, 500, { error: "Internal Server Error", message: "Could not resolve email" });
        }

        // 3. Generate OTP, persist with TTL, then email it
        const otp = generateOtp();
        const now = Math.floor(Date.now() / 1000);
        const expiresAt = now + OTP_TTL_SECONDS;

        await ddb.send(new PutCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Item: {
                userSub,
                otp,
                expiresAt,                  // DynamoDB TTL
                attempts: 0,
                verified: false,
                used: false,
                purpose: "password_change",
                createdAt: new Date().toISOString(),
            },
        }));

        await sendNotificationEmail({
            to: email,
            subject: "Your DentiPal password change code",
            text: `Your password change code is ${otp}. It expires in 10 minutes. If you did not request this, ignore this email.`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
                    <h2 style="color: #111;">Password change verification</h2>
                    <p style="color: #444; font-size: 14px;">
                        Use the code below to confirm your password change. It expires in 10 minutes.
                    </p>
                    <div style="font-size: 28px; font-weight: 700; letter-spacing: 6px;
                                background: #f5f6f8; padding: 16px; text-align: center;
                                border-radius: 6px; margin: 16px 0;">
                        ${otp}
                    </div>
                    <p style="color: #888; font-size: 12px;">
                        If you did not request a password change, you can ignore this email and your password will stay the same.
                    </p>
                </div>
            `,
        });

        return json(event, 200, {
            status: "success",
            message: "Verification code sent",
            data: {
                emailMasked: maskEmail(email),
                expiresInSeconds: OTP_TTL_SECONDS,
                maxAttempts: OTP_MAX_ATTEMPTS,
            },
        });
    } catch (err: any) {
        console.error("requestPasswordChange failed", err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: "Failed to send verification code",
            details: { reason: err.message },
        });
    }
};
