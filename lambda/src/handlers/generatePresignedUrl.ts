import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION: string = process.env.REGION || "us-east-1";
const s3Client = new S3Client({ region: REGION });
const PRESIGN_TTL_SECONDS = 900; // 15 minutes

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

type FileType =
    | "profile-image"
    | "professional-resume"
    | "video-resume"
    | "professional-license"
    | "certificate"
    | "driving-license"
    | "clinic-office-image";

interface RequestBody {
    fileType: FileType;
    fileName: string;
    contentType: string;
    fileSize?: number;      // Raw byte size (client hint; S3 policy enforces actual limits)
    clinicId?: string;      // Only used for clinic-office-image keys
}

// ─── Per-file-type validation matrix ───────────────────────────────────────
// min/max are in RAW bytes. S3's content-length-range condition enforces
// these at upload time — the client cannot lie about the size.

const KB = 1024;
const MB = 1024 * 1024;

const SIZE_LIMITS: Record<FileType, { min: number; max: number }> = {
    "profile-image":        { min: 5 * KB,   max: 5 * MB },
    "clinic-office-image":  { min: 5 * KB,   max: 5 * MB },
    "professional-resume":  { min: 10 * KB,  max: 10 * MB },
    "professional-license": { min: 10 * KB,  max: 5 * MB },
    "driving-license":      { min: 10 * KB,  max: 5 * MB },
    "certificate":          { min: 10 * KB,  max: 5 * MB },
    "video-resume":         { min: 500 * KB, max: 100 * MB },
};

const MIME_ALLOWLIST: Record<FileType, string[]> = {
    "profile-image":        ["image/jpeg", "image/png", "image/webp"],
    "clinic-office-image":  ["image/jpeg", "image/png", "image/webp"],
    "professional-resume":  [
        "application/pdf",
        "application/msword",                                                          // .doc
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",     // .docx
    ],
    "professional-license": ["application/pdf", "image/jpeg", "image/png"],
    "driving-license":      ["application/pdf", "image/jpeg", "image/png"],
    "certificate":          ["application/pdf", "image/jpeg", "image/png"],
    "video-resume":         ["video/mp4", "video/quicktime", "video/webm"],
};

const EXTENSION_ALLOWLIST: Record<FileType, string[]> = {
    "profile-image":        [".jpg", ".jpeg", ".png", ".webp"],
    "clinic-office-image":  [".jpg", ".jpeg", ".png", ".webp"],
    "professional-resume":  [".pdf", ".doc", ".docx"],
    "professional-license": [".pdf", ".jpg", ".jpeg", ".png"],
    "driving-license":      [".pdf", ".jpg", ".jpeg", ".png"],
    "certificate":          [".pdf", ".jpg", ".jpeg", ".png"],
    "video-resume":         [".mp4", ".mov", ".webm"],
};

const ALL_FILE_TYPES: FileType[] = [
    "profile-image",
    "professional-resume",
    "video-resume",
    "professional-license",
    "certificate",
    "driving-license",
    "clinic-office-image",
];

const fmtBytes = (n: number): string => {
    if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
    if (n >= KB) return `${(n / KB).toFixed(0)} KB`;
    return `${n} B`;
};

const getExtension = (name: string): string => {
    const match = /\.[^./\\]+$/.exec(String(name || "").trim().toLowerCase());
    return match ? match[0] : "";
};

// POST /files/presigned-urls
// Returns an S3 presigned POST policy that the client uses to PUT the file
// directly to S3. Size/MIME/extension are enforced in the policy itself, so
// the client cannot bypass the caps.
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "POST";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };
    if (method !== "POST") return json(event, 405, { error: "Method not allowed" });

    // ─── Auth ──────────────────────────────────────────────────────────────
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    let userSub: string | undefined;
    let userEmail: string | undefined;
    try {
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new Error("Missing or invalid Authorization header");
        }
        const userInfo = extractUserFromBearerToken(authHeader);
        userSub = userInfo.sub;
        userEmail = userInfo.email;
    } catch (_err) {
        const claims =
            (event.requestContext as any)?.authorizer?.claims ||
            (event.requestContext as any)?.authorizer?.jwt?.claims;
        userSub = claims?.sub;
        userEmail = claims?.email;
        if (!userSub) {
            console.error("[uploadFile] Unauthorized request (no token, no claims)");
            return json(event, 401, { error: "Unauthorized" });
        }
    }

    // ─── Body ──────────────────────────────────────────────────────────────
    if (!event.body) return json(event, 400, { error: "Request body is required" });
    let body: RequestBody;
    try {
        body = JSON.parse(event.body) as RequestBody;
    } catch {
        return json(event, 400, { error: "Invalid JSON body" });
    }
    const { fileType, fileName, contentType, fileSize, clinicId } = body;

    // ─── Input checks ─────────────────────────────────────────────────────
    if (!ALL_FILE_TYPES.includes(fileType)) {
        return json(event, 400, { error: "Invalid fileType", allowedTypes: ALL_FILE_TYPES });
    }
    if (!fileName || typeof fileName !== "string") {
        return json(event, 400, { error: "fileName is required" });
    }
    if (!contentType || typeof contentType !== "string") {
        return json(event, 400, { error: "contentType is required" });
    }

    // MIME allowlist
    const mimeAllowed = MIME_ALLOWLIST[fileType];
    if (!mimeAllowed.includes(contentType.toLowerCase())) {
        return json(event, 400, {
            error: `File type "${contentType}" is not allowed for ${fileType}.`,
            details: { allowedMimeTypes: mimeAllowed },
        });
    }

    // Extension allowlist
    const ext = getExtension(fileName);
    const extAllowed = EXTENSION_ALLOWLIST[fileType];
    if (!ext || !extAllowed.includes(ext)) {
        return json(event, 400, {
            error: `File extension "${ext || "(none)"}" is not allowed for ${fileType}.`,
            details: { allowedExtensions: extAllowed },
        });
    }

    // Size pre-check (client-sent hint). Real enforcement is via S3 policy.
    const limits = SIZE_LIMITS[fileType];
    if (typeof fileSize === "number" && Number.isFinite(fileSize)) {
        if (fileSize < limits.min) {
            return json(event, 400, {
                error: `File is too small. Minimum for ${fileType} is ${fmtBytes(limits.min)}.`,
                details: {
                    minSize: limits.min,
                    minSizeLabel: fmtBytes(limits.min),
                    receivedSize: fileSize,
                },
            });
        }
        if (fileSize > limits.max) {
            return json(event, 400, {
                error: `File is too large. Maximum for ${fileType} is ${fmtBytes(limits.max)}.`,
                details: {
                    maxSize: limits.max,
                    maxSizeLabel: fmtBytes(limits.max),
                    receivedSize: fileSize,
                },
            });
        }
    }

    // ─── Bucket resolution ─────────────────────────────────────────────────
    const buckets: Record<FileType, string | undefined> = {
        "profile-image":        process.env.PROFILE_IMAGES_BUCKET,
        "clinic-office-image":  process.env.CLINIC_OFFICE_IMAGES_BUCKET,
        "professional-resume":  process.env.PROFESSIONAL_RESUMES_BUCKET,
        "video-resume":         process.env.VIDEO_RESUMES_BUCKET,
        "professional-license": process.env.PROFESSIONAL_LICENSES_BUCKET,
        "certificate":          process.env.CERTIFICATES_BUCKET,
        "driving-license":      process.env.DRIVING_LICENSES_BUCKET,
    };
    const bucketName = buckets[fileType];
    if (!bucketName) {
        console.error(`[uploadFile] Missing bucket env var for fileType: ${fileType}`);
        return json(event, 500, { error: `Server configuration error: bucket not configured for ${fileType}.` });
    }

    // ─── Object key (user-scoped, collision-resistant) ────────────────────
    const sanitizedFileName = String(fileName).replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const keyPrefix =
        fileType === "clinic-office-image" && clinicId
            ? `${clinicId}/${fileType}`
            : `${userSub}/${fileType}`;
    const objectKey = `${keyPrefix}/${Date.now()}-${sanitizedFileName}`;

    // ─── Presigned POST with size + content-type enforcement ──────────────
    try {
        const { url, fields } = await createPresignedPost(s3Client, {
            Bucket: bucketName,
            Key: objectKey,
            Conditions: [
                ["content-length-range", limits.min, limits.max],
                ["eq", "$Content-Type", contentType],
            ],
            Fields: {
                "Content-Type": contentType,
                "x-amz-meta-uploaded-by": userSub || "unknown",
                "x-amz-meta-user-email": userEmail || "unknown",
                "x-amz-meta-original-filename": sanitizedFileName,
            },
            Expires: PRESIGN_TTL_SECONDS,
        });

        console.log("[uploadFile] Issued presigned POST", {
            bucket: bucketName,
            key: objectKey,
            fileType,
            contentType,
            sizeRange: [limits.min, limits.max],
        });

        return json(event, 200, {
            url,
            fields,
            objectKey,
            bucket: bucketName,
            expiresIn: PRESIGN_TTL_SECONDS,
            limits: {
                min: limits.min,
                max: limits.max,
                minLabel: fmtBytes(limits.min),
                maxLabel: fmtBytes(limits.max),
            },
        });
    } catch (err: any) {
        console.error("[uploadFile] Failed to create presigned POST:", err?.name, err?.message);
        return json(event, 500, { error: "Failed to prepare upload. Please try again." });
    }
};
