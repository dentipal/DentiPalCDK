// index.ts
import {
    S3Client,
    PutObjectCommand,
    PutObjectCommandInput
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Initialize the S3 client (AWS SDK v3)
const s3Client = new S3Client({ region: process.env.REGION });

// Type aliases for defined file types
type FileType = "profile-image" | "certificate" | "video-resume";

// Define Request Body interface
interface RequestBody {
    fileType: FileType;
    fileName: string;
    contentType: string;
    fileSize: number; // in bytes
}

// Define Response Body interface for successful response
interface SuccessBody {
    message: string;
    presignedUrl: string;
    objectKey: string;
    bucket: string;
    fileType: FileType;
    expiresIn: number;
    uploadInstructions: {
        method: "PUT";
        headers: { "Content-Type": string };
    };
}

// Define Error Body interface
interface ErrorBody {
    error: string;
    [key: string]: any;
}

// Environment variables
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";

const CORS = {
    "Access-Control-Allow-Origin": "*", // Keeping '*' as in original, despite ALLOWED_ORIGIN variable
    "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json",
};

// --- Helper Functions ---

const ok = (body: SuccessBody, code: number = 200): APIGatewayProxyResult => ({
    statusCode: code,
    headers: CORS,
    body: JSON.stringify(body),
});

const bad = (msg: string, code: number = 400, extra: Record<string, any> = {}): APIGatewayProxyResult => ({
    statusCode: code,
    headers: CORS,
    body: JSON.stringify({ error: msg, ...extra } as ErrorBody),
});

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Determine HTTP method
    // FIX: Cast event.requestContext to 'any' to safely access the 'http' property 
    // which is common in API Gateway v2 but sometimes missing in v1 typings.
    const method = (event?.requestContext as any)?.http?.method || event?.httpMethod;

    // CORS preflight
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    try {
        // Auth (Cognito authorizer)
        // Access claims via event.requestContext.authorizer structure
        const claims = (event.requestContext.authorizer as any)?.claims;
        const userSub: string | undefined = claims?.sub;
        const userEmail: string | undefined = claims?.email;

        if (!userSub) return bad("Unauthorized", 401);

        if (method !== "POST") return bad("Method not allowed", 405);

        if (!event.body) return bad("Request body is required", 400);

        // Parse and destructure body
        const { fileType, fileName, contentType, fileSize }: RequestBody = JSON.parse(event.body);

        // --- Validation ---

        // 1. Validate fileType
        const types: FileType[] = ["profile-image", "certificate", "video-resume"];
        if (!types.includes(fileType)) return bad("Invalid file type", 400);

        // 2. Size limits (match your policy)
        const maxSizes: Record<FileType, number> = {
            "profile-image": 5 * 1024 * 1024,   // 5MB
            certificate: 10 * 1024 * 1024,      // 10MB
            "video-resume": 100 * 1024 * 1024   // 100MB
        };
        if (fileSize && fileSize > maxSizes[fileType]) {
            return bad(
                `File size exceeds limit of ${maxSizes[fileType] / (1024 * 1024)}MB for ${fileType}`,
                400
            );
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
            return bad(
                `Invalid content type for ${fileType}. Allowed: ${allowedContentTypes[fileType].join(", ")}`,
                400
            );
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
            return bad("Server configuration error: Missing bucket name.", 500);
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

        return ok({
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
        } as SuccessBody); 

    } catch (error) {
        console.error("Error generating presigned URL:", error);
        return bad("Internal server error", 500);
    }
};