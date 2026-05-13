import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "crypto";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

const OTP_MAX_ATTEMPTS = 5;
const VERIFICATION_TOKEN_TTL_SECONDS = 10 * 60;     // 10 min to finish the flow

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    // 1. Authenticate
    let userSub: string;
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const info = extractUserFromBearerToken(authHeader);
        userSub = info.sub;
    } catch (err: any) {
        return json(event, 401, { error: "Unauthorized", message: err.message || "Invalid token" });
    }

    // 2. Parse body
    if (!event.body) return json(event, 400, { error: "Bad Request", message: "Request body required" });
    let otpInput: string;
    try {
        const body = JSON.parse(event.body);
        otpInput = String(body.otp || "").trim();
    } catch {
        return json(event, 400, { error: "Bad Request", message: "Invalid JSON body" });
    }
    if (!otpInput || !/^\d{6}$/.test(otpInput)) {
        return json(event, 400, { error: "Bad Request", message: "OTP must be 6 digits" });
    }

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

        // 4. Compare OTP — increment attempts on mismatch
        if (record.otp !== otpInput) {
            await ddb.send(new UpdateCommand({
                TableName: process.env.PASSWORD_OTP_TABLE!,
                Key: { userSub },
                UpdateExpression: "SET attempts = if_not_exists(attempts, :zero) + :one",
                ExpressionAttributeValues: { ":zero": 0, ":one": 1 },
            }));
            return json(event, 401, { error: "Unauthorized", message: "Incorrect verification code" });
        }

        // 5. Mark OTP as verified (but NOT used yet) and attach a token.
        //    The token must be presented in the final confirm step.
        //    If the user cancels (closes the dialog) and never calls confirm,
        //    nothing happens — the row TTL-expires and the password is unchanged.
        const verificationToken = randomBytes(24).toString("hex");
        const verificationExpiresAt = now + VERIFICATION_TOKEN_TTL_SECONDS;

        await ddb.send(new UpdateCommand({
            TableName: process.env.PASSWORD_OTP_TABLE!,
            Key: { userSub },
            UpdateExpression: "SET verified = :t, verifiedAt = :now, " +
                              "verificationToken = :token, verificationExpiresAt = :exp",
            ExpressionAttributeValues: {
                ":t": true,
                ":now": new Date().toISOString(),
                ":token": verificationToken,
                ":exp": verificationExpiresAt,
            },
        }));

        return json(event, 200, {
            status: "success",
            message: "Verification code accepted",
            data: {
                verificationToken,
                expiresInSeconds: VERIFICATION_TOKEN_TTL_SECONDS,
            },
        });
    } catch (err: any) {
        console.error("verifyPasswordOtp failed", err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: "Failed to verify code",
            details: { reason: err.message },
        });
    }
};
