import { 
    S3Client, 
    PutObjectCommand, 
    PutObjectCommandInput // Explicitly importing for type definition
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from "aws-lambda";

// --- 1. AWS and Environment Setup ---

// Set up S3 Client, assuming REGION is defined in the environment
const REGION: string = process.env.REGION || 'us-east-1';
const s3Client: S3Client = new S3Client({ region: REGION });

// --- 2. Type Definitions ---

/** Interface for the configuration object passed to createUploadHandler */
interface UploadConfig {
    fileType: string;
    bucketEnvVar: string;
    maxSize: number;
    allowedContentTypes: string[];
}

/** Interface for the expected incoming request body */
interface RequestBody {
    fileName?: string;
    contentType?: string;
    fileSize?: number;
}

/** Interface for a standard Lambda result body (for success and error responses) */
interface ResponseBody {
    message?: string;
    error?: string;
    presignedUrl?: string;
    objectKey?: string;
    bucket?: string;
    fileType?: string;
    expiresIn?: number;
    uploadInstructions?: {
        method: string;
        headers: { "Content-Type": string };
    };
    [key: string]: any;
}

/** Interface for the Cognito claims, assuming APIGatewayProxyEventV1 structure. */
interface CognitoClaims {
    sub?: string;
    email?: string;
    [key: string]: any;
}

// --- 3. Shared Helper Functions ---

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,PUT",
    "Content-Type": "application/json",
};

const ok = (body: ResponseBody, code: number = 200): APIGatewayProxyResult => ({
    statusCode: code,
    headers: CORS,
    body: JSON.stringify(body),
});

const bad = (msg: string, code: number = 400, extra: Record<string, any> = {}): APIGatewayProxyResult => ({
    statusCode: code,
    headers: CORS,
    body: JSON.stringify({ error: msg, ...extra }),
});

// --- 4. Handler Factory ---

type LambdaHandler = (event: APIGatewayProxyEvent, context: Context) => Promise<APIGatewayProxyResult>;

/**
 * Creates a Lambda handler function that generates an S3 presigned PUT URL.
 * @param config - Configuration object specifying file type, bucket, size limit, and content types.
 * @returns A fully functional AWS Lambda handler.
 */
const createUploadHandler = (config: UploadConfig): LambdaHandler => {
    const { fileType, bucketEnvVar, maxSize, allowedContentTypes } = config;

    return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
        // Determine HTTP method from V1 or V2 context structure
        const method: string | undefined = event.requestContext.httpMethod || event.httpMethod;
        let path: string | undefined = event.path;

        if (!path) {
            return bad("Request path is missing.", 400);
        }

        console.log("Request path before processing:", path); 

        // Remove API Gateway stage from the path, e.g., '/prod'
        path = path.replace("/prod", "");

        console.log("Processed path:", path);

        // CORS preflight check for OPTIONS method
        if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

        // Ensure only PUT requests are processed
        if (method !== "PUT") return bad("Method not allowed", 405);

        // Auth (Cognito authorizer claims from request context)
        const claims: CognitoClaims = (event.requestContext.authorizer?.claims || event.requestContext.authorizer || {}) as CognitoClaims;
        const userSub: string | undefined = claims.sub;
        const userEmail: string | undefined = claims.email;

        if (!userSub) return bad("Unauthorized: Missing 'sub' claim in token.", 401);

        if (!event.body) return bad("Request body is required", 400);

        // Get the bucket name from environment variables
        const bucketName: string | undefined = process.env[bucketEnvVar];
        if (!bucketName) {
            console.error(`Missing env var: ${bucketEnvVar}`);
            return bad("Internal server configuration error: Missing S3 bucket environment variable.", 500);
        }

        // Parse the incoming body to extract file details
        let requestBody: RequestBody;
        try {
            requestBody = JSON.parse(event.body);
        } catch (e) {
            return bad("Invalid JSON in request body.", 400);
        }

        const { fileName, contentType, fileSize } = requestBody;

        // 1. Validate file size
        if (!fileSize || typeof fileSize !== 'number' || fileSize <= 0 || fileSize > maxSize) {
            return bad(
                `Invalid or excessive file size. Limit is ${maxSize / (1024 * 1024)}MB for ${fileType}.`,
                400
            );
        }

        // 2. Validate content type
        if (!contentType || !allowedContentTypes.includes(contentType)) {
            return bad(
                `Invalid content type for ${fileType}. Allowed: ${allowedContentTypes.join(", ")}`,
                400
            );
        }

        // 3. Create the S3 key
        const sanitizedFileName: string = String(fileName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const objectKey: string = `${userSub}/${fileType}/${Date.now()}-${sanitizedFileName}`;

        // 4. Create the presigned PUT URL parameters
        const putObjectParams: PutObjectCommandInput = {
            Bucket: bucketName,
            Key: objectKey,
            ContentType: contentType,
            ContentLength: fileSize,
            Metadata: {
                "uploaded-by": userSub,
                "user-email": userEmail || "unknown",
                "upload-timestamp": new Date().toISOString(),
                "original-filename": fileName || "unknown",
            },
        };

        const command = new PutObjectCommand(putObjectParams);
        
        // 5. Generate the presigned URL (expires in 1 hour)
        const expiresInSeconds: number = 3600;
        const presignedUrl: string = await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });

        // 6. Return success response
        return ok({
            message: "Presigned URL generated successfully",
            presignedUrl,
            objectKey,
            bucket: bucketName,
            fileType: fileType,
            expiresIn: expiresInSeconds,
            uploadInstructions: {
                method: "PUT",
                headers: { "Content-Type": contentType },
            },
        });
    };
};

// --- 5. Exported Handlers (Created using the factory) ---

/** Handler for generating a presigned URL to upload a Professional Profile Image. */
export const profileImageHandler: LambdaHandler = createUploadHandler({
    fileType: "profile-image",
    bucketEnvVar: "PROFILE_IMAGES_BUCKET",
    maxSize: 5 * 1024 * 1024, // 5MB
    allowedContentTypes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
});

/** Handler for generating a presigned URL to upload a Professional Certificate. */
export const certificateHandler: LambdaHandler = createUploadHandler({
    fileType: "certificate",
    bucketEnvVar: "CERTIFICATES_BUCKET",
    maxSize: 10 * 1024 * 1024, // 10MB
    allowedContentTypes: ["application/pdf", "image/jpeg", "image/png"],
});

/** Handler for generating a presigned URL to upload a Video Resume. */
export const videoResumeHandler: LambdaHandler = createUploadHandler({
    fileType: "video-resume",
    bucketEnvVar: "VIDEO_RESUMES_BUCKET",
    maxSize: 100 * 1024 * 1024, // 100MB
    allowedContentTypes: ["video/mp4", "video/webm", "video/ogg", "video/avi", "video/mov"],
});