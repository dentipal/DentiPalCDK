import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand,
    AdminGetUserCommand,
    AdminRemoveUserFromGroupCommand,
    AdminListGroupsForUserCommand,
    ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import { getPathSegmentAfter } from "./leadShared";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

const findUsernameBySub = async (sub: string): Promise<string | undefined> => {
    // ListUsers Filter is the only API that lets us look up by sub. Username for
    // delete operations defaults to email — we resolve it explicitly here so the
    // path param can be the sub (which is what the team list shows).
    const resp = await cognito.send(new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Filter: `sub = "${sub}"`,
        Limit: 1,
    }));
    return resp.Users?.[0]?.Username;
};

/**
 * DELETE /admin/team/{userSub} — Admin only. **Permanent delete.**
 *
 * Strict guards:
 *   1. Caller must hold the Admin role (requireInternalGroup).
 *   2. Caller cannot delete themselves (foot-gun prevention).
 *   3. Target must be an internal-team user (`userType:internal` in address attr)
 *      — defends against a guessed-sub deletion of a clinic / professional user.
 *   4. Group memberships are removed first, then the Cognito record is deleted.
 *
 * Activity rows attributed to the deleted user remain in DynamoDB; the
 * timeline shows "Unknown" for those entries (resolveDisplayName falls back).
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

        // /{proxy+} integration → parse the path segment that follows /admin/team/.
        const targetSub = getPathSegmentAfter(event, "team") || "";
        if (!targetSub) {
            return json(event, 400, { error: "Bad Request", message: "userSub path parameter is required" });
        }
        if (targetSub === caller.sub) {
            return json(event, 400, { error: "Bad Request", message: "You cannot delete your own account." });
        }

        const username = await findUsernameBySub(targetSub);
        if (!username) {
            return json(event, 404, { error: "Not Found", message: "No user with that sub" });
        }

        // Defense-in-depth: refuse to delete anyone who isn't an internal-team user.
        const userResp = await cognito.send(new AdminGetUserCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: username,
        }));
        const address = userResp.UserAttributes?.find(a => a.Name === "address")?.Value || "";
        if (!address.includes("userType:internal")) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Target user is not an internal team member.",
            });
        }

        // Best-effort: remove the user from every group first. Cognito's
        // AdminDeleteUser implicitly handles group cleanup, but doing it
        // explicitly leaves the audit trail in CloudTrail clearer.
        try {
            const groups = await cognito.send(new AdminListGroupsForUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: username,
            }));
            for (const g of groups.Groups || []) {
                if (!g.GroupName) continue;
                await cognito.send(new AdminRemoveUserFromGroupCommand({
                    UserPoolId: process.env.USER_POOL_ID!,
                    Username: username,
                    GroupName: g.GroupName,
                }));
            }
        } catch (groupCleanupError) {
            console.warn("[removeTeamMember] group cleanup failed (continuing):", groupCleanupError);
        }

        await cognito.send(new AdminDeleteUserCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: username,
        }));

        return json(event, 200, {
            status: "success",
            message: "Team member deleted.",
            data: { sub: targetSub },
        });
    } catch (error: any) {
        console.error("[removeTeamMember] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to delete team member",
        });
    }
};
