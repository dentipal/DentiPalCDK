import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    ListUsersInGroupCommand,
    UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
    INTERNAL_GROUPS,
    type InternalRole,
} from "../utils";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface TeamMemberRow {
    sub: string;
    email: string;
    firstName: string;
    lastName: string;
    status: string;
    enabled: boolean;
    roles: InternalRole[];
    createdAt?: string;
}

const attr = (user: UserType, name: string): string =>
    user.Attributes?.find(a => a.Name === name)?.Value || "";

/**
 * GET /admin/team — Admin only.
 *
 * Lists every internal team member by paginating ListUsersInGroup across all
 * four internal groups, deduping by sub. A user can hold multiple roles, so
 * the response collapses them into a single row with a roles[] field.
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

        const bySub = new Map<string, TeamMemberRow>();

        for (const group of INTERNAL_GROUPS) {
            let nextToken: string | undefined;
            do {
                const resp = await cognito.send(new ListUsersInGroupCommand({
                    UserPoolId: process.env.USER_POOL_ID!,
                    GroupName: group,
                    Limit: 60,
                    NextToken: nextToken,
                }));
                for (const user of resp.Users || []) {
                    const sub = attr(user, "sub");
                    if (!sub) continue;
                    const existing = bySub.get(sub);
                    if (existing) {
                        if (!existing.roles.includes(group)) existing.roles.push(group);
                        continue;
                    }
                    bySub.set(sub, {
                        sub,
                        email: attr(user, "email"),
                        firstName: attr(user, "given_name"),
                        lastName: attr(user, "family_name"),
                        status: user.UserStatus || "UNKNOWN",
                        enabled: user.Enabled !== false,
                        roles: [group],
                        createdAt: user.UserCreateDate?.toISOString(),
                    });
                }
                nextToken = resp.NextToken;
            } while (nextToken);
        }

        const members = Array.from(bySub.values()).sort((a, b) => {
            // Newest first; users without a createdAt sink to the bottom.
            const aT = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bT = b.createdAt ? Date.parse(b.createdAt) : 0;
            return bT - aT;
        });

        return json(event, 200, {
            status: "success",
            data: { members, count: members.length },
        });
    } catch (error: any) {
        console.error("[listTeam] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to list team members",
        });
    }
};
