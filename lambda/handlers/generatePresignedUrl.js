"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const s3Client = new S3Client({ region: process.env.REGION });

// 👇 Set allowed origins (dev + prod). Use "*" during development if you prefer.
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const CORS = {
  "Access-Control-Allow-Origin": "*", // or the specific origin
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
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

const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod;

  // CORS preflight
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    // Auth (Cognito authorizer)
    const userSub = event.requestContext.authorizer?.claims?.sub;
    const userEmail = event.requestContext.authorizer?.claims?.email;
    if (!userSub) return bad("Unauthorized", 401);

    if (method !== "POST") return bad("Method not allowed", 405);

    if (!event.body) return bad("Request body is required", 400);

    const { fileType, fileName, contentType, fileSize } = JSON.parse(event.body || "{}");

    // Validate fileType
    const types = ["profile-image", "certificate", "video-resume"];
    if (!types.includes(fileType)) return bad("Invalid file type", 400);

    // Size limits (match your policy)
    const maxSizes = {
      "profile-image": 5 * 1024 * 1024, // 5MB
      certificate: 10 * 1024 * 1024,    // 10MB
      "video-resume": 100 * 1024 * 1024 // 100MB
    };
    if (fileSize && fileSize > maxSizes[fileType]) {
      return bad(
        `File size exceeds limit of ${maxSizes[fileType] / (1024 * 1024)}MB for ${fileType}`,
        400
      );
    }

    // Validate content types
    // 💡 FIX: Added 'video/quicktime' and 'application/octet-stream' for better video compatibility.
    const allowedContentTypes = {
      "profile-image": ["image/jpeg", "image/png", "image/gif", "image/webp"],
      certificate: ["application/pdf", "image/jpeg", "image/png"],
      "video-resume": [
        "video/mp4",
        "video/webm",
        "video/ogg",
        "video/avi",
        "video/mov",
        "video/quicktime", // Common for .mov files
        "application/octet-stream" // Generic fallback for certain browsers
      ],
    };

    if (!allowedContentTypes[fileType].includes(contentType)) {
      return bad(
        `Invalid content type for ${fileType}. Allowed: ${allowedContentTypes[fileType].join(", ")}`,
        400
      );
    }

    // Buckets from env
    const buckets = {
      "profile-image": process.env.PROFILE_IMAGES_BUCKET,
      certificate: process.env.CERTIFICATES_BUCKET,
      "video-resume": process.env.VIDEO_RESUMES_BUCKET,
    };
    
    // Check if the required bucket env variable exists
    if (!buckets[fileType]) {
        console.error(`Bucket environment variable for ${fileType} is missing.`);
        return bad("Server configuration error: Missing bucket name.", 500);
    }

    const sanitizedFileName = String(fileName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const objectKey = `${userSub}/${fileType}/${Date.now()}-${sanitizedFileName}`;

    // Create presigned PUT URL
    const command = new PutObjectCommand({
      Bucket: buckets[fileType],
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
      bucket: buckets[fileType],
      fileType,
      expiresIn: 3600,
      uploadInstructions: {
        method: "PUT",
        headers: { "Content-Type": contentType }, // must match presign
      },
    });
  } catch (error) {
    console.error("Error generating presigned URL:", error);
    return bad("Internal server error", 500);
  }
};

exports.handler = handler;