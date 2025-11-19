import {
    S3Client,
    DeleteObjectCommand,
    HeadObjectCommand,
    HeadObjectCommandInput,
    DeleteObjectCommandInput,
    HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Initialize the S3 client
const s3Client = new S3Client({ region: process.env.REGION });

// Define the type for CORS headers
const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

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

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Authentication Check
        // Accessing the 'sub' claim directly from the authorizer context
        const userSub: string | undefined = event.requestContext?.authorizer?.claims?.sub;
        if (!userSub) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized: Missing user authentication context' })
            };
        }
        
        // 2. HTTP Method Check (CORS preflight is implicitly handled by API Gateway/Router)
        if (event.httpMethod !== 'DELETE') {
            return {
                statusCode: 405,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Method not allowed. Only DELETE is supported.' })
            };
        }

        // 3. Extract File Type from path
        const pathParts = event.path.split('/');
        const pathFileType = pathParts[pathParts.length - 1]; // e.g., 'profile-images'
        const fileType = fileTypeMap[pathFileType]; // e.g., 'profile-image'
        
        if (!fileType) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid file type in path. Must be one of: profile-images, certificates, video-resumes' })
            };
        }

        // 4. Get Object Key from query parameters
        const objectKey: string | undefined = event.queryStringParameters?.key;
        if (!objectKey) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Object key is required as a query parameter' })
            };
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
             return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: `Server configuration error: Bucket not defined for ${fileType}` })
            };
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
            if (uploadedBy !== userSub) {
                return {
                    statusCode: 403,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'Access denied - you can only delete your own files' })
                };
            }

            // 7. Delete the file
            const deleteCommandInput: DeleteObjectCommandInput = {
                Bucket: bucket,
                Key: objectKey
            };
            const deleteCommand = new DeleteObjectCommand(deleteCommandInput);
            await s3Client.send(deleteCommand);

            // 8. Return success response
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    message: `File of type '${fileType}' deleted successfully`,
                    objectKey,
                    bucket,
                    fileType,
                    deletedAt: new Date().toISOString(),
                    metadata: {
                        originalFilename: headResponse.Metadata?.['original-filename'],
                        uploadTimestamp: headResponse.Metadata?.['upload-timestamp']
                    }
                })
            };
        } catch (error) {
            const err = error as Error & { name?: string };
            
            // Handle file not found specific S3 errors
            if (err.name === 'NoSuchKey' || err.name === 'NotFound') {
                return {
                    statusCode: 404,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'File not found in the specified location' })
                };
            }
            
            // Re-throw if it's an unhandled error to be caught by the outer block
            throw err;
        }
    } catch (error) {
        const err = error as Error & { message?: string };
        console.error('Error deleting file:', err);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: err.message || 'Internal server error' })
        };
    }
};

exports.handler = handler;