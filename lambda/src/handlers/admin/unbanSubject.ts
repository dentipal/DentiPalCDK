import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminEnableUserCommand,
    ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import { dynamo, getPathSegmentAfter } from "./leadShared";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

const findUsernameBySub = async (sub: string): Promise<string | undefined> => {
    const resp = await cognito.send(new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Filter: `sub = "${sub}"`,
        Limit: 1,
    }));
    return resp.Users?.[0]?.Username;
};

/**
 * DELETE /admin/bans/{subjectType}/{subjectId} — Admin only.
 *
 * Reverses banSubject:
 *   - Removes the row from the Bans table.
 *   - For professional bans, also calls AdminEnableUser. Best-effort — DB
 *     deletion is the source of truth for login.
 *   - Clinic bans don't touch Cognito.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!requireInternalGroup(caller.groups, ["Admin"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin role required." });
        }

        // /{proxy+} integration → /admin/bans/{subjectType}/{subjectId}
        // getPathSegmentAfter("bans") returns the subjectType; the segment after
        // that is the subjectId.
        const subjectType = getPathSegmentAfter(event, "bans");
        if (subjectType !== "professional" && subjectType !== "clinic") {
            return json(event, 400, {
                error: "Bad Request",
                message: "Path must be /admin/bans/{professional|clinic}/{subjectId}",
            });
        }
        const subjectId = getPathSegmentAfter(event, subjectType);
        if (!subjectId) {
            return json(event, 400, { error: "Bad Request", message: "subjectId is required" });
        }

        await dynamo.send(new DeleteItemCommand({
            TableName: process.env.BANS_TABLE!,
            Key: marshall({ subjectType, subjectId }),
        }));

        if (subjectType === "professional") {
            try {
                const username = await findUsernameBySub(subjectId);
                if (username) {
                    await cognito.send(new AdminEnableUserCommand({
                        UserPoolId: process.env.USER_POOL_ID!,
                        Username: username,
                    }));
                }
            } catch (cognitoError) {
                console.warn("[unbanSubject] Cognito enable failed — DB ban already removed:", cognitoError);
            }
        }

        return json(event, 200, {
            status: "success",
            message: subjectType === "clinic" ? "Clinic unbanned." : "Professional unbanned.",
            data: { subjectType, subjectId },
        });
    } catch (error: any) {
        console.error("[unbanSubject] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to remove ban",
        });
    }
};
