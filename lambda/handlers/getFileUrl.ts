import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

const s3Client = new S3Client({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

interface AuthorizerClaims {
  sub?: string;
  ["custom:user_type"]?: string;
}

interface RequestContextWithAuth {
  authorizer?: {
    claims?: AuthorizerClaims;
  };
}

export const handler = async (
  event: APIGatewayProxyEvent & { requestContext: RequestContextWithAuth }
): Promise<APIGatewayProxyResult> => {
  let objectKeyToUse: string | undefined;

  try {
    const userSub = event.requestContext.authorizer?.claims?.sub;
    const userType =
      event.requestContext.authorizer?.claims?.["custom:user_type"];

    if (!userSub) {
      return json(401, { error: "Unauthorized" });
    }

    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    // Extract file type from path
    const pathParts = event.path.split("/");

    const fileTypeMap: Record<string, string> = {
      "profile-images": "profile-image",
      certificates: "certificate",
      "video-resumes": "video-resume",
    };

    const pathFileType = pathParts[pathParts.length - 1];
    const fileType = fileTypeMap[pathFileType];

    if (!fileType) {
      return json(400, { error: "Invalid file type in path" });
    }

    // Query params
    const encodedObjectKey = event.queryStringParameters?.key;
    if (!encodedObjectKey) {
      return json(400, { error: "Object key is required" });
    }

    objectKeyToUse = decodeURIComponent(encodedObjectKey);

    const userSubToAccess =
      event.queryStringParameters?.userSub || userSub;

    // Security check
    if (userSubToAccess !== userSub) {
      if (userType !== "clinic") {
        return json(403, { error: "Access denied" });
      }
    }

    // Bucket selection
    const buckets: Record<string, string | undefined> = {
      "profile-image": process.env.PROFILE_IMAGES_BUCKET,
      certificate: process.env.CERTIFICATES_BUCKET,
      "video-resume": process.env.VIDEO_RESUMES_BUCKET,
    };

    const bucket = buckets[fileType];

    if (!bucket) {
      console.error(
        `Bucket environment variable not set for fileType: ${fileType}`
      );
      return json(500, {
        error: `Server configuration error: Missing bucket for ${fileType}`,
      });
    }

    // --- CORE LOGIC ---
    try {
      console.log(
        `Attempting HeadObject: Bucket=${bucket}, Key=${objectKeyToUse}`
      );

      const headCommand = new HeadObjectCommand({
        Bucket: bucket,
        Key: objectKeyToUse,
      });

      const headResponse: HeadObjectCommandOutput = await s3Client.send(
        headCommand
      );

      // File ownership check
      const uploadedBy = headResponse.Metadata?.["uploaded-by"];

      if (uploadedBy && uploadedBy !== userSubToAccess) {
        console.warn(
          `Access denied: uploadedBy (${uploadedBy}) does not match userSubToAccess (${userSubToAccess})`
        );
        return json(403, {
          error: "Access denied - file not owned by specified user",
        });
      }

      // Generate presigned URL
      const getCommand = new GetObjectCommand({
        Bucket: bucket,
        Key: objectKeyToUse,
      });

      const presignedUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: 3600,
      });

      return json(200, {
        message: "File URL retrieved successfully",
        fileUrl: presignedUrl,
        objectKey: objectKeyToUse,
        bucket,
        fileType,
        metadata: {
          contentType: headResponse.ContentType,
          contentLength: headResponse.ContentLength,
          lastModified: headResponse.LastModified,
          uploadedBy: headResponse.Metadata?.["uploaded-by"],
          originalFilename: headResponse.Metadata?.["original-filename"],
          uploadTimestamp: headResponse.Metadata?.["upload-timestamp"],
        },
        expiresIn: 3600,
      });
    } catch (error: any) {
      if (error.name === "NoSuchKey" || error.name === "NotFound") {
        console.error(
          `S3 error: File not found for Key: ${objectKeyToUse} in Bucket: ${bucket}`
        );
        return json(404, { error: "File not found" });
      }

      console.error("Unhandled S3 Error during Head/Get command:", error);

      return json(500, {
        error: `Failed to retrieve file: ${
          error.message || "Internal error"
        }`,
      });
    }
  } catch (error) {
    console.error("Error getting file URL:", error);

    return json(500, { error: "Internal server error" });
  }
};