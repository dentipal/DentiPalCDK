import {
    S3Client,
    DeleteObjectCommand,
    HeadObjectCommand,
    HeadObjectCommandInput,
    DeleteObjectCommandInput,
    HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. Initialization ---
const REGION = process.env.REGION || "us-east-1";
const s3Client = new S3Client({ region: REGION });

// --- 2. Helpers ---
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the map for path segments to internal file types
const fileTypeMap: Record<string, 'profile-image' | 'certificate' | 'video-resume'> = {
    'profile-images': 'profile-image',
    'certificates': 'certificate',
    'video-resumes': 'video-resume',
};

// Define the structure for the bucket mapping
interface BucketMap {
    'profile-image': string | undefined;
    'certificate': string | undefined;
    'video-resume': string | undefined;
}

// --- 3. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    if (method !== 'DELETE') {
        return json(405, { error: 'Method not allowed. Only DELETE is supported.' });
    }

    try {
        // 2. Authentication (Access Token)
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, { 
                error: authError.message || "Invalid access token" 
            });
        }

        // 3. Extract File Type from path
        // Robust logic to find the file type segment (handles /foo/bar/profile-images)
        const pathParts = event.path.split('/');
        const pathFileType = pathParts.find(part => fileTypeMap[part]) || pathParts[pathParts.length - 1];
        const fileType = fileTypeMap[pathFileType]; 
        
        if (!fileType) {
            return json(400, { error: 'Invalid file type in path. Must be one of: profile-images, certificates, video-resumes' });
        }

        // 4. Get Object Key from query parameters
        const objectKey: string | undefined = event.queryStringParameters?.key;
        if (!objectKey) {
            return json(400, { error: 'Object key is required as a query parameter' });
        }

        // 5. Determine Bucket Name
        const buckets: BucketMap = {
            'profile-image': process.env.PROFILE_IMAGES_BUCKET,
            'certificate': process.env.CERTIFICATES_BUCKET,
            'video-resume': process.env.VIDEO_RESUMES_BUCKET
        };
        const bucket: string | undefined = buckets[fileType];

        if (!bucket) {
            console.error(`Missing environment variable for bucket type: ${fileType}`);
            return json(500, { error: `Server configuration error: Bucket not defined for ${fileType}` });
        }

        try {
            // 6. Check if file exists and verify ownership (HeadObject)
            const headCommandInput: HeadObjectCommandInput = {
                Bucket: bucket,
                Key: objectKey
            };
            const headCommand = new HeadObjectCommand(headCommandInput);
            const headResponse: HeadObjectCommandOutput = await s3Client.send(headCommand);

            const uploadedBy = headResponse.Metadata?.['uploaded-by'];
            
            // Ownership check (metadata is stored in lowercase by S3)
            // If no metadata exists, we might deny or allow based on policy. Secure default is deny.
            if (!uploadedBy || uploadedBy !== userSub) {
                console.warn(`User ${userSub} attempted to delete file owned by ${uploadedBy}`);
                return json(403, { error: 'Access denied - you can only delete your own files' });
            }

            // 7. Delete the file
            const deleteCommandInput: DeleteObjectCommandInput = {
                Bucket: bucket,
                Key: objectKey
            };
            const deleteCommand = new DeleteObjectCommand(deleteCommandInput);
            await s3Client.send(deleteCommand);

            // 8. Return success response
            return json(200, {
                message: `File of type '${fileType}' deleted successfully`,
                objectKey,
                fileType,
                deletedAt: new Date().toISOString(),
                metadata: {
                    originalFilename: headResponse.Metadata?.['original-filename'],
                    uploadTimestamp: headResponse.Metadata?.['upload-timestamp']
                }
            });

        } catch (error) {
            const err = error as Error & { name?: string };
            
            // Handle file not found specific S3 errors
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return json(404, { error: 'File not found in the specified location' });
            }
            
            throw err;
        }
    } catch (error) {
        const err = error as Error & { message?: string };
        console.error('Error deleting file:', err);
        return json(500, { error: err.message || 'Internal server error' });
    }
};