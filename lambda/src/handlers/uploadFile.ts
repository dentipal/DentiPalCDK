import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

const s3Client = new S3Client({ region: process.env.REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

type FileType = "profile-image" | "professional-resume" | "video-resume" | "professional-license" | "certificate" | "driving-license" | "clinic-office-image";

interface RequestBody {
    fileType: FileType;
    fileName: string;
    contentType: string;
    fileBase64: string; // base64-encoded file payload
    clinicId?: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "POST";
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        let userSub: string | undefined;
        let userEmail: string | undefined;

        try {
            if (!authHeader || !authHeader.startsWith("Bearer ")) throw new Error("Missing or invalid Authorization header");
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userEmail = userInfo.email;
        } catch (err: any) {
            const claims = (event.requestContext as any)?.authorizer?.claims || (event.requestContext as any)?.authorizer?.jwt?.claims;
            userSub = claims?.sub;
            userEmail = claims?.email;
            if (!userSub) {
                const reason = authHeader ? 'Failed to decode/validate Authorization token' : 'Missing Authorization header and no authorizer claims';
                console.error('Unauthorized upload request:', reason);
                return json(event, 401, { error: 'Unauthorized', reason });
            }
        }

        if (method !== "POST") return json(event, 405, { error: "Method not allowed" });
        if (!event.body) return json(event, 400, { error: "Request body is required" });

        const { fileType, fileName, contentType, fileBase64, clinicId } = JSON.parse(event.body) as RequestBody;

        const allowed: FileType[] = ["profile-image", "professional-resume", "video-resume", "professional-license", "certificate", "driving-license", "clinic-office-image"];
        if (!allowed.includes(fileType)) return json(event, 400, { error: "Invalid fileType" });

        if (fileType === "clinic-office-image" && !clinicId) return json(event, 400, { error: "clinicId is required for clinic-office-image uploads" });

        if (!fileBase64) return json(event, 400, { error: "fileBase64 is required (base64-encoded)" });

        const buckets: Record<FileType, string | undefined> = {
            "profile-image": process.env.PROFILE_IMAGES_BUCKET,
            "professional-resume": process.env.PROFESSIONAL_RESUMES_BUCKET,
            "video-resume": process.env.VIDEO_RESUMES_BUCKET,
            "professional-license": process.env.PROFESSIONAL_LICENSES_BUCKET,
            "certificate": process.env.CERTIFICATES_BUCKET,
            "driving-license": process.env.DRIVING_LICENSES_BUCKET,
            "clinic-office-image": process.env.CLINIC_OFFICE_IMAGES_BUCKET,
        };

        const bucketName = buckets[fileType];
        if (!bucketName) return json(event, 500, { error: `Server configuration error: Missing bucket for ${fileType}` });

        const sanitizedFileName = String(fileName || "file").replace(/[^a-zA-Z0-9.\-_]/g, "_");
        // Clinic office images are keyed by clinicId so they can be retrieved by clinic.
        // All other file types are keyed by userSub.
        const keyPrefix = fileType === "clinic-office-image" ? clinicId! : userSub;
        const objectKey = `${keyPrefix}/${fileType}/${Date.now()}-${sanitizedFileName}`;

        // decode base64
        const buffer = Buffer.from(fileBase64, "base64");

        const putParams = {
            Bucket: bucketName,
            Key: objectKey,
            Body: buffer,
            ContentType: contentType || "application/octet-stream",
            Metadata: {
                "uploaded-by": userSub,
                "user-email": userEmail || "unknown",
                "original-filename": fileName,
                "upload-timestamp": new Date().toISOString()
            }
        };

        try {
            await s3Client.send(new PutObjectCommand(putParams));
            console.log("File uploaded to S3", { bucket: bucketName, key: objectKey });
        } catch (err) {
            console.error("Failed to upload file to S3:", err);
            return json(event, 500, { error: "Failed to store file in S3" });
        }

        // also store a metadata JSON record beside the file
        try {
            const meta = {
                objectKey,
                originalFileName: fileName,
                contentType,
                size: buffer.length,
                uploadedBy: userSub,
                userEmail: userEmail || null,
                createdAt: new Date().toISOString(),
                uploadStatus: "complete"
            };
            const metaKey = `${keyPrefix}/${fileType}/.meta/${Date.now()}-${sanitizedFileName}.json`;
            await s3Client.send(new PutObjectCommand({ Bucket: bucketName, Key: metaKey, Body: JSON.stringify(meta), ContentType: "application/json" }));
            console.log("Upload metadata stored to S3", { bucket: bucketName, metaKey });
        } catch (metaErr) {
            console.warn("Failed to store upload metadata to S3:", metaErr);
        }

        return json(event, 201, { message: "File stored", bucket: bucketName, objectKey });

    } catch (error) {
        console.error("Error in uploadFile handler:", error);
        return json(event, 500, { error: "Internal server error" });
    }
};
