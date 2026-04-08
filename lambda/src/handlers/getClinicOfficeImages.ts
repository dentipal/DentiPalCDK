import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";

const s3Client = new S3Client({ region: process.env.REGION });

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj),
});

/**
 * GET /files/clinic-office-images?clinicId={clinicId}
 * Lists objects in the clinic office images bucket under the clinic's prefix
 * and returns a presigned URL for the latest image.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        extractUserFromBearerToken(authHeader); // validates token only

        const clinicId = event.queryStringParameters?.clinicId;
        if (!clinicId) {
            return json(400, { error: "clinicId query parameter is required" });
        }

        const bucket = process.env.CLINIC_OFFICE_IMAGES_BUCKET;
        if (!bucket) {
            return json(500, { error: "Server configuration error: Missing bucket" });
        }

        const prefix = `${clinicId}/clinic-office-image/`;

        const listResult = await s3Client.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
        }));

        const files = (listResult.Contents || [])
            .filter(obj => obj.Key && !obj.Key.includes("/.meta/"))
            .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

        if (files.length === 0) {
            return json(404, { error: "No office image found for this clinic" });
        }

        const latestKey = files[0].Key!;
        const presignedUrl = await getSignedUrl(
            s3Client,
            new GetObjectCommand({ Bucket: bucket, Key: latestKey }),
            { expiresIn: 3600 }
        );

        return json(200, {
            message: "Clinic office image retrieved successfully",
            fileUrl: presignedUrl,
            objectKey: latestKey,
            expiresIn: 3600,
        });
    } catch (error: any) {
        console.error("Error getting clinic office image:", error);

        if (
            error.message === "Authorization header missing" ||
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims"
        ) {
            return json(401, { error: "Unauthorized", details: error.message });
        }

        return json(500, { error: "Internal server error" });
    }
};
