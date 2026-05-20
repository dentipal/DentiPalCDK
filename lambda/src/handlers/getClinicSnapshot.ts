import {
    DynamoDBClient,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { corsHeaders } from "./corsHeaders";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });
const DELETED_CLINIC_SNAPSHOTS_TABLE = process.env.DELETED_CLINIC_SNAPSHOTS_TABLE!;

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// GET /clinics/{clinicId}/snapshot
// Public to any authenticated user — used by the frontend fallback UI when a
// clinic referenced by a job/application/chat no longer exists. Returns the
// last-known display fields snapshotted at soft-delete time. If the snapshot
// row is missing (e.g. clinic was deleted before this table existed), returns
// a generic "Clinic no longer available" stub so the UI still has something
// to render.
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const clinicId: string | undefined =
            event.pathParameters?.clinicId || event.pathParameters?.proxy;

        if (!clinicId) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Clinic ID is required",
                timestamp: new Date().toISOString(),
            });
        }

        const resp = await dynamoClient.send(new GetItemCommand({
            TableName: DELETED_CLINIC_SNAPSHOTS_TABLE,
            Key: { clinicId: { S: clinicId } },
        }));

        const item = resp.Item;
        const fallback = {
            clinicId,
            isDeleted: true,
            name: item?.name?.S || "Clinic no longer available",
            officeImageKey: item?.officeImageKey?.S || null,
            city: item?.city?.S || null,
            state: item?.state?.S || null,
            deletedAt: item?.deletedAt?.S || null,
        };

        return json(event, 200, {
            status: "success",
            statusCode: 200,
            data: fallback,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error fetching clinic snapshot:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to fetch clinic snapshot",
            details: { reason: err.message },
            timestamp: new Date().toISOString(),
        });
    }
};

exports.handler = handler;
