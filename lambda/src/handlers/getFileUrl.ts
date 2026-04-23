import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";

const s3Client = new S3Client({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

// Centralized implementation that returns a presigned URL for a fixed fileType
const generateFileUrl = async (
  event: APIGatewayProxyEvent,
  fileType: string
): Promise<APIGatewayProxyResult> => {
  // IMPORTANT: call this FIRST on every entry point. `CORS_HEADERS` is backed
  // by a module-level `_currentOrigin` that Lambda warm-start containers share
  // across invocations. Without this, a previous request from one origin
  // leaks its Access-Control-Allow-Origin into the next request from another
  // origin — which is exactly what caused the CORS error for localhost:5173.
  setOriginFromEvent(event);

  let objectKeyToUse: string | undefined;
  try {
    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // Auth
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;
    const userType = userInfo.userType;

    if (event.httpMethod !== "GET") {
      return json(405, { error: "Method not allowed" });
    }

    // Query params
    const encodedObjectKey = event.queryStringParameters?.key;
    if (!encodedObjectKey) {
      return json(400, { error: "Object key is required" });
    }

    objectKeyToUse = decodeURIComponent(encodedObjectKey);

    const userSubToAccess = event.queryStringParameters?.userSub || userSub;

    // Determine if user has clinic-level access (via custom:user_type OR cognito groups)
    const clinicGroups = ["Root", "ClinicAdmin", "ClinicManager", "ClinicViewer"];
    const userGroups = userInfo.groups || [];
    const isClinicUser = userType === "clinic" || userGroups.some(g => clinicGroups.includes(g));

    // Security check: only clinic users can access other users' files
    if (userSubToAccess !== userSub && !isClinicUser) {
      return json(403, { error: "Access denied" });
    }

    // Bucket selection
    const buckets: Record<string, string | undefined> = {
      "profile-image": process.env.PROFILE_IMAGES_BUCKET,
      "video-resume": process.env.VIDEO_RESUMES_BUCKET,
      "professional-license": process.env.PROFESSIONAL_LICENSES_BUCKET,
      "professional-resume": process.env.PROFESSIONAL_RESUMES_BUCKET,
      "driving-license": process.env.DRIVING_LICENSES_BUCKET,
      "clinic-office-image": process.env.CLINIC_OFFICE_IMAGES_BUCKET,
    };

    const bucket = buckets[fileType];

    if (!bucket) {
      console.error(`Bucket environment variable not set for fileType: ${fileType}`);
      return json(500, { error: `Server configuration error: Missing bucket for ${fileType}` });
    }

    // --- CORE LOGIC ---
    try {
      console.log(`Attempting HeadObject: Bucket=${bucket}, Key=${objectKeyToUse}`);

      const headCommand = new HeadObjectCommand({
        Bucket: bucket,
        Key: objectKeyToUse,
      });

      const headResponse: HeadObjectCommandOutput = await s3Client.send(headCommand);

      // File ownership check - clinic users can access any professional's files
      const uploadedBy = headResponse.Metadata?.["uploaded-by"];

      if (uploadedBy && uploadedBy !== userSubToAccess && !isClinicUser) {
        console.warn(`Access denied: uploadedBy (${uploadedBy}) does not match userSubToAccess (${userSubToAccess})`);
        return json(403, { error: "Access denied - file not owned by specified user" });
      }

      // Generate presigned URL. Use a 24h lifetime so users scrolling through
      // their own profile don't hit AccessDenied on URLs that expired while
      // the tab was open. The frontend still re-fetches on-demand for the
      // belt-and-suspenders case (see useDocuments.downloadDocument).
      const PRESIGN_TTL_SECONDS = 24 * 60 * 60;
      const getCommand = new GetObjectCommand({ Bucket: bucket, Key: objectKeyToUse });
      const presignedUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: PRESIGN_TTL_SECONDS,
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
        expiresIn: PRESIGN_TTL_SECONDS,
      });
    } catch (error: any) {
      if (error.name === "NoSuchKey" || error.name === "NotFound") {
        console.error(`S3 error: File not found for Key: ${objectKeyToUse} in Bucket: ${bucket}`);
        return json(404, { error: "File not found" });
      }

      console.error("Unhandled S3 Error during Head/Get command:", error);
      return json(500, { error: `Failed to retrieve file: ${error.message || "Internal error"}` });
    }
  } catch (error: any) {
    console.error("Error getting file URL:", error);

    if (error.message === "Authorization header missing" ||
        error.message?.startsWith("Invalid authorization header") ||
        error.message === "Invalid access token format" ||
        error.message === "Failed to decode access token" ||
        error.message === "User sub not found in token claims") {
      return json(401, { error: "Unauthorized", details: error.message });
    }

    return json(500, { error: "Internal server error" });
  }
};

// Exported handlers for specific file types. Wire these to separate API endpoints.
export const getProfileImage = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "profile-image");
export const getProfessionalResume = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "professional-resume");
export const getProfessionalLicense = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "professional-license");
export const getDrivingLicense = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "driving-license");
export const getVideoResume = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "video-resume");
export const getClinicOfficeImage = async (event: APIGatewayProxyEvent) => generateFileUrl(event, "clinic-office-image");

// Keep generic handler for backward compatibility; it will route based on path segments.
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
  // try to infer fileType from path for older routes
  try {
    const pathParts = event.path.split("/");
    const pathFileType = pathParts[pathParts.length - 1];
    const map: Record<string, string> = {
      "profile-images": "profile-image",
      "video-resumes": "video-resume",
      "professional-licenses": "professional-license",
      "professional-resumes": "professional-resume",
      "driving-licenses": "driving-license",
      "clinic-office-images": "clinic-office-image",
    };
    const fileType = map[pathFileType];
    if (fileType) return generateFileUrl(event, fileType);
    return json(400, { error: "Invalid file type in path" });
  } catch (err: any) {
    console.error("Handler routing error:", err);
    return json(500, { error: "Internal server error" });
  }
};
 