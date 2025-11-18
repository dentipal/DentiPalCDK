"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3Client = new client_s3_1.S3Client({ region: process.env.REGION });

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

const handler = async (event) => {
    try {
        // Get user information from the event
        const userSub = event.requestContext.authorizer?.claims?.sub;
        if (!userSub) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }
        if (event.httpMethod !== 'DELETE') {
            return {
                statusCode: 405,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }

        // Extract file type from path
        const pathParts = event.path.split('/');
        const fileTypeMap = {
            'profile-images': 'profile-image',
            'certificates': 'certificate',
            'video-resumes': 'video-resume'
        };
        const pathFileType = pathParts[pathParts.length - 1];
        const fileType = fileTypeMap[pathFileType];
        if (!fileType) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Invalid file type in path' })
            };
        }

        // Get query parameters
        const objectKey = event.queryStringParameters?.key;
        if (!objectKey) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Object key is required' })
            };
        }

        // Determine bucket
        const buckets = {
            'profile-image': process.env.PROFILE_IMAGES_BUCKET,
            'certificate': process.env.CERTIFICATES_BUCKET,
            'video-resume': process.env.VIDEO_RESUMES_BUCKET
        };
        const bucket = buckets[fileType];

        try {
            // Check if file exists and verify ownership
            const headCommand = new client_s3_1.HeadObjectCommand({
                Bucket: bucket,
                Key: objectKey
            });
            const headResponse = await s3Client.send(headCommand);

            const uploadedBy = headResponse.Metadata?.['uploaded-by'];
            if (uploadedBy !== userSub) {
                return {
                    statusCode: 403,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'Access denied - you can only delete your own files' })
                };
            }

            // Delete the file
            const deleteCommand = new client_s3_1.DeleteObjectCommand({
                Bucket: bucket,
                Key: objectKey
            });
            await s3Client.send(deleteCommand);

            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    message: 'File deleted successfully',
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
            if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
                return {
                    statusCode: 404,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'File not found' })
                };
            }
            throw error;
        }
    } catch (error) {
        console.error('Error deleting file:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
exports.handler = handler;
