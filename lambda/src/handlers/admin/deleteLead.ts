import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    BatchWriteItemCommand,
    DeleteItemCommand,
    GetItemCommand,
    QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import {
    dynamo,
    LEADS_TABLE,
    LEAD_ACTIVITY_TABLE,
    getLeadIdFromEvent,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/**
 * DELETE /admin/leads/{leadId} — Admin only.
 *
 * Strict guards:
 *   1. Admin role required (requireInternalGroup).
 *   2. Lead must exist (returns 404 if not).
 *   3. All activity rows for the lead are deleted in BatchWriteItem chunks of 25
 *      BEFORE the lead row, so a partial failure leaves the activity orphaned
 *      under a still-existing lead (recoverable) rather than a deleted lead with
 *      live activity.
 *   4. The lead row itself is deleted last.
 *
 * Cascade is intentional — a lead's activity has no value once the lead is gone.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!requireInternalGroup(caller.groups, ["Admin"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin role required to delete leads." });
        }

        const leadId = getLeadIdFromEvent(event);
        if (!leadId) {
            return json(event, 400, { error: "Bad Request", message: "leadId path parameter is required" });
        }

        // Step 1: confirm the lead exists. 404 if not — saves a wasted activity scan.
        const head = await dynamo.send(new GetItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            ProjectionExpression: "leadId",
        }));
        if (!head.Item) {
            return json(event, 404, { error: "Not Found", message: "No lead with that id" });
        }

        // Step 2: collect every activity row for this lead.
        const activityIds: string[] = [];
        let exclusiveStartKey: Record<string, any> | undefined;
        do {
            const resp: any = await dynamo.send(new QueryCommand({
                TableName: LEAD_ACTIVITY_TABLE,
                KeyConditionExpression: "leadId = :id",
                ExpressionAttributeValues: { ":id": { S: leadId } },
                ProjectionExpression: "activityId",
                ExclusiveStartKey: exclusiveStartKey,
            }));
            for (const item of resp.Items || []) {
                if (item.activityId?.S) activityIds.push(item.activityId.S);
            }
            exclusiveStartKey = resp.LastEvaluatedKey;
        } while (exclusiveStartKey);

        // Step 3: batch-delete activity in chunks of 25 (BatchWriteItem cap).
        // Retries unprocessed items per the SDK contract.
        const BATCH = 25;
        for (let i = 0; i < activityIds.length; i += BATCH) {
            const slice = activityIds.slice(i, i + BATCH);
            let pending: Record<string, any[]> | undefined = {
                [LEAD_ACTIVITY_TABLE]: slice.map((activityId) => ({
                    DeleteRequest: { Key: marshall({ leadId, activityId }) },
                })),
            };
            let attempt = 0;
            while (pending && Object.keys(pending).length > 0) {
                const resp: any = await dynamo.send(new BatchWriteItemCommand({
                    RequestItems: pending as any,
                }));
                pending = resp.UnprocessedItems && Object.keys(resp.UnprocessedItems).length > 0
                    ? resp.UnprocessedItems
                    : undefined;
                if (pending) {
                    attempt++;
                    if (attempt > 5) {
                        throw new Error("BatchWriteItem retry budget exceeded during activity cleanup");
                    }
                    await new Promise((r) => setTimeout(r, 200 * attempt));
                }
            }
        }

        // Step 4: delete the lead row itself.
        await dynamo.send(new DeleteItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
        }));

        return json(event, 200, {
            status: "success",
            message: "Lead deleted.",
            data: { leadId, activityRowsDeleted: activityIds.length },
        });
    } catch (error: any) {
        console.error("[deleteLead] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to delete lead",
        });
    }
};
