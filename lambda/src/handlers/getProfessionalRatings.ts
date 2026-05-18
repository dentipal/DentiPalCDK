import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const RATINGS_TABLE = process.env.PROFESSIONAL_RATINGS_TABLE!;
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

function getMethod(event: APIGatewayProxyEvent): string {
    return event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
}

function getUserSubFromPath(event: APIGatewayProxyEvent): string | undefined {
    if (event.pathParameters?.userSub) return event.pathParameters.userSub;
    const proxy = event.pathParameters?.proxy;
    if (proxy) {
        const parts = proxy.split("/").filter(Boolean);
        const idx = parts.indexOf("professionals");
        if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
    const raw = event.path || (event.requestContext as any)?.http?.path || "";
    const segs = raw.split("/").filter(Boolean);
    const idx = segs.findIndex((s: string) => s === "professionals");
    if (idx >= 0 && segs[idx + 1]) return segs[idx + 1];
    return undefined;
}

function unmarshallItem(item: Record<string, AttributeValue>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
        if ("S" in v && v.S !== undefined) out[k] = v.S;
        else if ("N" in v && v.N !== undefined) out[k] = Number(v.N);
        else if ("BOOL" in v && v.BOOL !== undefined) out[k] = v.BOOL;
    }
    return out;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (getMethod(event) === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    // Auth required (any signed-in user can view ratings — same as public profile).
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        extractUserFromBearerToken(authHeader);
    } catch (err) {
        return json(event, 401, { error: "Unauthorized", message: (err as Error)?.message || "Invalid token" });
    }

    const professionalUserSub = getUserSubFromPath(event);
    if (!professionalUserSub) {
        return json(event, 400, { error: "Missing professional userSub in path" });
    }

    try {
        const [ratingsRes, profileRes] = await Promise.all([
            dynamodb.send(new QueryCommand({
                TableName: RATINGS_TABLE,
                KeyConditionExpression: "professionalUserSub = :p",
                ExpressionAttributeValues: { ":p": { S: professionalUserSub } },
                Limit: 100,
                ScanIndexForward: false,
            })),
            dynamodb.send(new GetItemCommand({
                TableName: PROFESSIONAL_PROFILES_TABLE,
                Key: { userSub: { S: professionalUserSub } },
                ProjectionExpression: "avgRating, ratingCount",
            })),
        ]);

        const ratings = (ratingsRes.Items || []).map(unmarshallItem);

        const avgRating = profileRes.Item?.avgRating?.N
            ? Number(profileRes.Item.avgRating.N)
            : null;
        const ratingCount = profileRes.Item?.ratingCount?.N
            ? Number(profileRes.Item.ratingCount.N)
            : 0;

        return json(event, 200, {
            professionalUserSub,
            avgRating,
            ratingCount,
            ratings,
        });
    } catch (err) {
        console.error("[getProfessionalRatings] failed", err);
        return json(event, 500, { error: "Failed to load ratings" });
    }
};
