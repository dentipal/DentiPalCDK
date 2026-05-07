import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminAddUserToGroupCommand,
    AdminGetUserCommand,
    AdminDeleteUserCommand,
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

interface InviteBody {
    email?: string;
    firstName?: string;
    lastName?: string;
    role?: InternalRole;
}

/**
 * POST /admin/team — Admin only.
 *
 * Invites a new internal team member. Cognito emails them a temporary password;
 * on first login they hit NEW_PASSWORD_REQUIRED (handled by /auth/login forwarding
 * the challenge + /auth/respond-new-password completing it).
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
        const body: InviteBody = JSON.parse(event.body);
        const email = (body.email || "").toLowerCase().trim();
        const { firstName, lastName, role } = body;

        const missing = [
            !email && "email",
            !firstName && "firstName",
            !lastName && "lastName",
            !role && "role",
        ].filter(Boolean);
        if (missing.length > 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Required fields are missing",
                details: { missingFields: missing },
            });
        }
        if (!INTERNAL_GROUPS.includes(role!)) {
            return json(event, 400, {
                error: "Bad Request",
                message: `Invalid role. Must be one of: ${INTERNAL_GROUPS.join(", ")}`,
            });
        }

        const userAttributes = [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
            { Name: "given_name", Value: firstName! },
            { Name: "family_name", Value: lastName! },
            { Name: "phone_number", Value: "+10000000000" },
            { Name: "address", Value: `userType:internal|role:${role!.toLowerCase()}` },
        ];

        let createdUsername: string | undefined;
        try {
            const createResp = await cognito.send(new AdminCreateUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                UserAttributes: userAttributes,
                DesiredDeliveryMediums: ["EMAIL"],
                // No TemporaryPassword — Cognito generates one and emails it to the user.
            }));
            createdUsername = createResp.User?.Username || email;

            await cognito.send(new AdminAddUserToGroupCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: email,
                GroupName: role!,
            }));
        } catch (innerError: any) {
            // Roll back if the create succeeded but the group-add failed,
            // so we don't end up with a user invited via email but stuck without a role.
            if (createdUsername && innerError.name !== "UsernameExistsException") {
                try {
                    await cognito.send(new AdminDeleteUserCommand({
                        UserPoolId: process.env.USER_POOL_ID!,
                        Username: createdUsername,
                    }));
                } catch (rollbackError) {
                    console.error("[inviteTeamMember] rollback failed:", rollbackError);
                }
            }
            throw innerError;
        }

        // Return the new user's sub for the team list to refresh optimistically.
        const fresh = await cognito.send(new AdminGetUserCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Username: email,
        }));
        const sub = fresh.UserAttributes?.find(a => a.Name === "sub")?.Value || "";

        return json(event, 200, {
            status: "success",
            message: `${role} invitation sent to ${email}`,
            data: { email, role, sub, status: fresh.UserStatus || "FORCE_CHANGE_PASSWORD" },
        });
    } catch (error: any) {
        console.error("[inviteTeamMember] error:", error);
        if (error.name === "UsernameExistsException") {
            return json(event, 409, {
                error: "Conflict",
                message: "A user with this email already exists.",
            });
        }
        if (error.name === "InvalidParameterException") {
            return json(event, 400, {
                error: "Bad Request",
                message: error.message || "Invalid parameters",
            });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to invite team member",
        });
    }
};
