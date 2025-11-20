import {
    S3Client,
    PutObjectCommand,
    PutObjectCommandInput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the S3 client (AWS SDK v3)
const s3Client = new S3Client({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Type aliases for defined file types
type FileType = "profile-image" | "certificate" | "video-resume";

// Define Request Body interface
interface RequestBody {
    fileType: FileType;
    fileName: string;
    contentType: string;
    fileSize: number; // in bytes
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Auth (Cognito authorizer)
        const claims = event.requestContext?.authorizer?.claims;
        // Cast claims to any to access properties safely if types aren't strict
        const userSub: string | undefined = claims?.sub;
        const userEmail: string | undefined = claims?.email;

        if (!userSub) {
            return json(401, { error: "Unauthorized" });
        }

        if (method !== "POST") {
            return json(405, { error: "Method not allowed" });
        }

        if (!event.body) {
            return json(400, { error: "Request body is required" });
        }

        // Parse and destructure body
        const { fileType, fileName, contentType, fileSize }: RequestBody = JSON.parse(event.body);

        // --- Validation ---

        // 1. Validate fileType
        const types: FileType[] = ["profile-image", "certificate", "video-resume"];
        if (!types.includes(fileType)) {
            return json(400, { error: "Invalid file type" });
        }

        // 2. Size limits (match your policy)
        const maxSizes: Record<FileType, number> = {
            "profile-image": 5 * 1024 * 1024,   // 5MB
            certificate: 10 * 1024 * 1024,      // 10MB
            "video-resume": 100 * 1024 * 1024   // 100MB
        };
        
        if (fileSize && fileSize > maxSizes[fileType]) {
            return json(400, { 
                error: `File size exceeds limit of ${maxSizes[fileType] / (1024 * 1024)}MB for ${fileType}` 
            });
        }

        // 3. Validate content types
        const allowedContentTypes: Record<FileType, string[]> = {
            "profile-image": ["image/jpeg", "image/png", "image/gif", "image/webp"],
            certificate: ["application/pdf", "image/jpeg", "image/png"],
            "video-resume": [
                "video/mp4",
                "video/webm",
                "video/ogg",
                "video/avi",
                "video/mov",
                "video/quicktime", // Common for .mov files
                "application/octet-stream" // Generic fallback
            ],
        };

        if (!allowedContentTypes[fileType].includes(contentType)) {
            return json(400, { 
                error: `Invalid content type for ${fileType}. Allowed: ${allowedContentTypes[fileType].join(", ")}` 
            });
        }

        // 4. Check Bucket Configuration
        const buckets: Record<FileType, string | undefined> = {
            "profile-image": process.env.PROFILE_IMAGES_BUCKET,
            certificate: process.env.CERTIFICATES_BUCKET,
            "video-resume": process.env.VIDEO_RESUMES_BUCKET,
        };
        const bucketName = buckets[fileType];

        if (!bucketName) {
            console.error(`Bucket environment variable for ${fileType} is missing.`);
            return json(500, { error: "Server configuration error: Missing bucket name." });
        }

        // --- S3 Object Key Generation ---

        // Sanitize filename and create unique object key
        const sanitizedFileName = String(fileName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const objectKey = `${userSub}/${fileType}/${Date.now()}-${sanitizedFileName}`;

        // --- Create Presigned PUT URL ---

        // Command parameters for the PUT request
        const putCommandInput: PutObjectCommandInput = {
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
        };

        const command = new PutObjectCommand(putCommandInput);

        // Generate the signed URL, expiring in 3600 seconds (1 hour)
        const expiresInSeconds = 3600;
        const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });

        // --- Success Response ---

        return json(200, {
            message: "Presigned URL generated successfully",
            presignedUrl,
            objectKey,
            bucket: bucketName,
            fileType,
            expiresIn: expiresInSeconds,
            uploadInstructions: {
                method: "PUT",
                headers: { "Content-Type": contentType }, // Must match the Content-Type used in the signing
            },
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error generating presigned URL:", err);
        return json(500, { error: "Internal server error" });
    }
};