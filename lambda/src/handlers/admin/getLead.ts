import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    isInternalUser,
} from "../utils";
import { dynamo, LEADS_TABLE, getLeadIdFromEvent, type LeadRecord } from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/** GET /admin/leads/{leadId} — any internal role. */
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

        const resp = await dynamo.send(new GetItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
        }));
        if (!resp.Item) {
            return json(event, 404, { error: "Not Found", message: "No lead with that id" });
        }

        return json(event, 200, {
            status: "success",
            data: unmarshall(resp.Item) as LeadRecord,
        });
    } catch (error: any) {
        console.error("[getLead] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to fetch lead",
        });
    }
};
