import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { QueryCommand, type QueryCommandInput } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    isInternalUser,
} from "../utils";
import { dynamo, LEAD_ACTIVITY_TABLE, getLeadIdFromEvent } from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/**
 * GET /admin/leads/{leadId}/activity — any internal role.
 * Returns activity rows newest-first via SK descending order.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!isInternalUser(caller.groups)) {
            return json(event, 403, { error: "Forbidden", message: "Internal access required." });
        }

        const leadId = getLeadIdFromEvent(event);
        if (!leadId) {
            return json(event, 400, { error: "Bad Request", message: "leadId path parameter is required" });
        }

        const params: QueryCommandInput = {
            TableName: LEAD_ACTIVITY_TABLE,
            KeyConditionExpression: "leadId = :id",
            ExpressionAttributeValues: { ":id": { S: leadId } },
            ScanIndexForward: false, // newest first via ULID-prefixed SK
        };
        const resp = await dynamo.send(new QueryCommand(params));
        const items = (resp.Items || []).map((it) => unmarshall(it));

        return json(event, 200, {
            status: "success",
            data: { activity: items, count: items.length },
        });
    } catch (error: any) {
        console.error("[listLeadActivity] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to load lead activity",
        });
    }
};
