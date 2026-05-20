import { DynamoDBClient, GetItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot, requireInternalGroup } from "./utils";
import { corsHeaders } from "./corsHeaders";

// GET /clinic-root-account/backups/{ownerSub}              → list all backup rows for an owner
// GET /clinic-root-account/backups/{ownerSub}/{deletedAt}  → fetch one specific backup row
// Root + internal Admin only. Used for compliance / legal export of a
// Delete-Clinic-Root-Account backup row.

const ddb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });
const TABLE = "DentiPal-V5-ClinicAccountBackup";

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

const parseEmbeddedJsonFields = (item: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
        if (v && typeof v === "object" && typeof v.S === "string") {
            // Try to JSON.parse known JSON-string fields; leave plain strings alone.
            const stringFields = ["cognitoIdentity", "userProfile", "clinics", "clinicProfiles",
                "members", "ratingsReceived", "mediaIndex", "accountSummary",
                "completedJobs", "completedApplications"];
            if (stringFields.includes(k)) {
                try { out[k] = JSON.parse(v.S); } catch { out[k] = v.S; }
            } else {
                out[k] = v.S;
            }
        }
    }
    return out;
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const allowed = isRoot(userInfo.groups) || requireInternalGroup(userInfo.groups, ["Admin"]);
        if (!allowed) {
            return json(event, 403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root or Admin users can read account backups.",
            });
        }

        const ownerSub = event.pathParameters?.ownerSub;
        const deletedAt = event.pathParameters?.deletedAt;
        if (!ownerSub) {
            return json(event, 400, { error: "Bad Request", message: "ownerSub is required" });
        }

        if (deletedAt) {
            // Specific backup row.
            const resp = await ddb.send(new GetItemCommand({
                TableName: TABLE,
                Key: { ownerSub: { S: ownerSub }, deletedAt: { S: deletedAt } },
            }));
            if (!resp.Item) {
                return json(event, 404, { error: "Not Found", message: "Backup not found." });
            }
            return json(event, 200, {
                status: "success",
                data: parseEmbeddedJsonFields(resp.Item),
            });
        }

        // All backups for this owner — paginate the Query.
        const items: Record<string, any>[] = [];
        let exclusiveStart: any;
        do {
            const out = await ddb.send(new QueryCommand({
                TableName: TABLE,
                KeyConditionExpression: "ownerSub = :sub",
                ExpressionAttributeValues: { ":sub": { S: ownerSub } },
                ExclusiveStartKey: exclusiveStart,
            }));
            for (const it of out.Items || []) items.push(parseEmbeddedJsonFields(it));
            exclusiveStart = out.LastEvaluatedKey;
        } while (exclusiveStart);

        return json(event, 200, {
            status: "success",
            data: { ownerSub, backups: items, count: items.length },
        });
    } catch (error) {
        const err = error as Error;
        console.error("[getClinicRootAccountBackup] error:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: "Failed to fetch backup",
            details: { reason: err.message },
        });
    }
};

exports.handler = handler;
