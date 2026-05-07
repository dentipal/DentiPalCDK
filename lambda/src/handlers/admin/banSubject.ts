import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminDisableUserCommand,
    ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import { dynamo, resolveDisplayName } from "./leadShared";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface BanBody {
    subjectType?: "professional" | "clinic";
    subjectId?: string;
    displayLabel?: string;
    ownerSub?: string;       // required when subjectType === "clinic"
    reason?: string;
}

/**
 * Resolve a Cognito Username from a sub. Same trick as removeTeamMember.ts —
 * Username defaults to email in this pool, so we can't pass the sub directly
 * to AdminDisableUser.
 */
const findUsernameBySub = async (sub: string): Promise<string | undefined> => {
    const resp = await cognito.send(new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Filter: `sub = "${sub}"`,
        Limit: 1,
    }));
    return resp.Users?.[0]?.Username;
};

/**
 * POST /admin/bans — Admin only.
 *
 * Strict guards:
 *   1. Caller must hold the Admin role (requireInternalGroup).
 *   2. Caller cannot ban themselves (self-foot-gun: pro ban where caller.sub
 *      === subjectId, or clinic ban where caller.sub === ownerSub).
 *   3. ConditionExpression `attribute_not_exists(subjectId)` rejects double-bans.
 *   4. For professional bans: AdminDisableUser is the failsafe; the DB ban is
 *      the friendly path. Cognito failure is logged but doesn't fail the
 *      request — DB ban is enough to refuse login.
 *   5. For clinic bans: NO Cognito disable. The owner may run other unbanned
 *      clinics; we can't kill their account. The login check filters per-clinic.
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

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: BanBody = JSON.parse(event.body);
        const subjectType = body.subjectType;
        const subjectId = (body.subjectId || "").trim();
        const displayLabel = (body.displayLabel || "").trim() || subjectId;
        const ownerSub = (body.ownerSub || "").trim() || undefined;
        const reason = body.reason?.trim() || undefined;

        if (subjectType !== "professional" && subjectType !== "clinic") {
            return json(event, 400, {
                error: "Bad Request",
                message: "subjectType must be 'professional' or 'clinic'",
            });
        }
        if (!subjectId) {
            return json(event, 400, { error: "Bad Request", message: "subjectId is required" });
        }
        if (subjectType === "clinic" && !ownerSub) {
            return json(event, 400, {
                error: "Bad Request",
                message: "ownerSub is required when banning a clinic",
            });
        }

        // Self-ban guard.
        const blocksSelf =
            (subjectType === "professional" && subjectId === caller.sub) ||
            (subjectType === "clinic" && ownerSub === caller.sub);
        if (blocksSelf) {
            return json(event, 400, {
                error: "Bad Request",
                message: "You cannot ban your own account.",
            });
        }

        const bannedAt = new Date().toISOString();
        const bannedByName = await resolveDisplayName(caller.sub);

        try {
            await dynamo.send(new PutItemCommand({
                TableName: process.env.BANS_TABLE!,
                Item: marshall(
                    {
                        subjectType,
                        subjectId,
                        displayLabel,
                        ownerSub,
                        reason,
                        bannedAt,
                        bannedBy: caller.sub,
                        bannedByName,
                    },
                    { removeUndefinedValues: true }
                ),
                ConditionExpression: "attribute_not_exists(subjectId)",
            }));
        } catch (err: any) {
            if (err.name === "ConditionalCheckFailedException") {
                return json(event, 409, {
                    error: "Conflict",
                    message: "This subject is already banned.",
                });
            }
            throw err;
        }

        // For professional bans, also disable the Cognito user as a failsafe.
        if (subjectType === "professional") {
            try {
                const username = await findUsernameBySub(subjectId);
                if (username) {
                    await cognito.send(new AdminDisableUserCommand({
                        UserPoolId: process.env.USER_POOL_ID!,
                        Username: username,
                    }));
                } else {
                    console.warn("[banSubject] Cognito user not found for sub", subjectId);
                }
            } catch (cognitoError) {
                console.warn("[banSubject] Cognito disable failed — DB ban is in place:", cognitoError);
            }
        }

        return json(event, 200, {
            status: "success",
            message: subjectType === "clinic" ? "Clinic banned." : "Professional banned.",
            data: { subjectType, subjectId, bannedAt },
        });
    } catch (error: any) {
        console.error("[banSubject] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to apply ban",
        });
    }
};
