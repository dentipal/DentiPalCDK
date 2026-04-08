import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj),
});

const getAttr = (attrs: AttributeType[], name: string): string =>
    attrs.find(a => a.Name === name)?.Value ?? "";

/**
 * GET /users/me
 * Returns the currently logged-in user's profile from Cognito.
 * Reads: name, email, phone_number, given_name, family_name, sub.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);

        const userPoolId = process.env.USER_POOL_ID;
        if (!userPoolId) {
            return json(500, { error: "Server configuration error: USER_POOL_ID missing" });
        }

        const cognitoUser = await cognito.send(new AdminGetUserCommand({
            UserPoolId: userPoolId,
            Username: userInfo.sub,
        }));

        const attrs: AttributeType[] = cognitoUser.UserAttributes || [];

        const firstName = getAttr(attrs, "given_name");
        const lastName = getAttr(attrs, "family_name");
        const fullName = getAttr(attrs, "name") || [firstName, lastName].filter(Boolean).join(" ");

        return json(200, {
            status: "success",
            data: {
                sub: userInfo.sub,
                name: fullName,
                email: getAttr(attrs, "email"),
                phone: getAttr(attrs, "phone_number"),
                givenName: firstName,
                familyName: lastName,
            },
        });
    } catch (error: any) {
        console.error("Error fetching current user:", error);

        if (
            error.message === "Authorization header missing" ||
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims"
        ) {
            return json(401, { error: "Unauthorized", details: error.message });
        }

        return json(500, { error: "Internal server error" });
    }
};
