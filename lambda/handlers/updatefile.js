"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

// Export all three handlers
exports.videoResumeHandler = exports.certificateHandler = exports.profileImageHandler = void 0;

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({ region: process.env.REGION });

// --- Shared Helper Functions ---
const CORS = {
  "Access-Control-Allow-Origin": "*", // Allow any origin
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,PUT", // Allow PUT
  "Content-Type": "application/json",
};

const ok = (body, code = 200) => ({
  statusCode: code,
  headers: CORS,
  body: JSON.stringify(body),
});

const bad = (msg, code = 400, extra = {}) => ({
  statusCode: code,
  headers: CORS,
  body: JSON.stringify({ error: msg, ...extra }),
});

// --- Handler Factory ---
const createUploadHandler = (config) => {
  const { fileType, bucketEnvVar, maxSize, allowedContentTypes } = config;

  return async (event) => {
    const method = event?.requestContext?.http?.method || event?.httpMethod;
    let path = event?.rawPath || event?.path; // Capture the full path

    console.log("Request path before processing:", path);  // Log to debug the path

    // Remove '/prod' from the path (since the API Gateway stage is included in the URL)
    path = path.replace("/prod", "");

    console.log("Processed path:", path);  // Log after removing "/prod"

    // CORS preflight check for OPTIONS method
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    // Ensure only PUT requests are processed
    if (method !== "PUT") return bad("Method not allowed", 405);

    // Auth (Cognito authorizer)
    const userSub = event.requestContext.authorizer?.claims?.sub;
    const userEmail = event.requestContext.authorizer?.claims?.email;
    if (!userSub) return bad("Unauthorized", 401);

    if (!event.body) return bad("Request body is required", 400);

    // Get the bucket name from environment variables
    const bucketName = process.env[bucketEnvVar];
    if (!bucketName) {
      console.error(`Missing env var: ${bucketEnvVar}`);
      return bad("Internal server configuration error", 500);
    }

    // Parse the incoming body to extract file details
    const { fileName, contentType, fileSize } = JSON.parse(event.body || "{}");

    // Validate file size
    if (fileSize && fileSize > maxSize) {
      return bad(
        `File size exceeds limit of ${maxSize / (1024 * 1024)}MB for ${fileType}`,
        400
      );
    }

    // Validate content type
    if (!allowedContentTypes.includes(contentType)) {
      return bad(
        `Invalid content type for ${fileType}. Allowed: ${allowedContentTypes.join(", ")}`,
        400
      );
    }

    // Create the S3 key
    const sanitizedFileName = String(fileName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const objectKey = `${userSub}/${fileType}/${Date.now()}-${sanitizedFileName}`;

    // Create the presigned PUT URL for S3
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
      ContentType: contentType,
      ContentLength: fileSize,
      Metadata: {
        "uploaded-by": userSub,
        "user-email": userEmail || "unknown",
        "upload-timestamp": new Date().toISOString(),
        "original-filename": fileName,
      },
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return ok({
      message: "Presigned URL generated successfully",
      presignedUrl,
      objectKey,
      bucket: bucketName,
      fileType: fileType, // The specific fileType for this handler
      expiresIn: 3600,
      uploadInstructions: {
        method: "PUT",
        headers: { "Content-Type": contentType },
      },
    });
  };
};

// --- Exported Handlers ---
// 1. Profile Image Handler
exports.profileImageHandler = createUploadHandler({
  fileType: "profile-image",
  bucketEnvVar: "PROFILE_IMAGES_BUCKET",
  maxSize: 5 * 1024 * 1024, // 5MB
  allowedContentTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
});

// 2. Certificate Handler
exports.certificateHandler = createUploadHandler({
  fileType: "certificate",
  bucketEnvVar: "CERTIFICATES_BUCKET",
  maxSize: 10 * 1024 * 1024, // 10MB
  allowedContentTypes: ["application/pdf", "image/jpeg", "image/png"],
});

// 3. Video Resume Handler
exports.videoResumeHandler = createUploadHandler({
  fileType: "video-resume",
  bucketEnvVar: "VIDEO_RESUMES_BUCKET",
  maxSize: 100 * 1024 * 1024, // 100MB
  allowedContentTypes: ["video/mp4", "video/webm", "video/ogg", "video/avi", "video/mov"],
});
