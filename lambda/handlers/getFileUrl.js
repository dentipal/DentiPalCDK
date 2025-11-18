"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const s3Client = new client_s3_1.S3Client({ region: process.env.REGION });

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

const handler = async (event) => {
    // 💡 NOTE: The primary issue was that 'objectKeyFromQuery' was defined but not used
    // in the S3 commands. The S3 commands used the uninitialized variable 'objectKey'.
    // The fix is to ensure the decoded key is used consistently.

    let objectKeyToUse; // Declare variable here to be available in catch blocks

    try {
        const userSub = event.requestContext.authorizer?.claims?.sub;
        const userType = event.requestContext.authorizer?.claims?.['custom:user_type'];

        if (!userSub) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders, body: "" };
        }
        if (event.httpMethod !== 'GET') {
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

        // Get query parameters and DECODE the key
        const encodedObjectKey = event.queryStringParameters?.key;
        if (!encodedObjectKey) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Object key is required' })
            };
        }
        
        // Assign the decoded key to the scoped variable
        objectKeyToUse = decodeURIComponent(encodedObjectKey);

        const userSubToAccess = event.queryStringParameters?.userSub || userSub;

        // Security check
        if (userSubToAccess !== userSub) {
            if (userType !== 'clinic') {
                return {
                    statusCode: 403,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'Access denied' })
                };
            }
        }

        // Determine bucket
        const buckets = {
            'profile-image': process.env.PROFILE_IMAGES_BUCKET,
            'certificate': process.env.CERTIFICATES_BUCKET,
            'video-resume': process.env.VIDEO_RESUMES_BUCKET
        };
        const bucket = buckets[fileType];

        // DIAGNOSTIC CHECK (Missing Bucket Name)
        if (!bucket) {
            console.error(`Bucket environment variable not set for fileType: ${fileType}`);
            return {
                 statusCode: 500,
                 headers: corsHeaders,
                 body: JSON.stringify({ error: `Server configuration error: Missing bucket for ${fileType}` })
            };
        }

        // --- CORE LOGIC ---
        try {
            // Log the exact S3 parameters being used
            console.log(`Attempting HeadObject: Bucket=${bucket}, Key=${objectKeyToUse}`);

            // Check if file exists and get metadata
            const headCommand = new client_s3_1.HeadObjectCommand({
                Bucket: bucket,
                Key: objectKeyToUse // <-- FIXED: Use the decoded key
            });
            const headResponse = await s3Client.send(headCommand);

            // Verify file ownership
            const uploadedBy = headResponse.Metadata?.["uploaded-by"];

            if (uploadedBy && uploadedBy !== userSubToAccess) {
              console.warn(
                `Access denied: uploadedBy (${uploadedBy}) does not match userSubToAccess (${userSubToAccess})`
              );
              return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({
                  error: "Access denied - file not owned by specified user",
                }),
              };
            }

            // Generate presigned URL for GET operation
            const getCommand = new client_s3_1.GetObjectCommand({
                Bucket: bucket,
                Key: objectKeyToUse // <-- FIXED: Use the decoded key
            });
            const presignedUrl = await (0, s3_request_presigner_1.getSignedUrl)(s3Client, getCommand, {
                expiresIn: 3600 // 1 hour
            });

            // Successful 200 Response
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({
                    message: 'File URL retrieved successfully',
                    fileUrl: presignedUrl,
                    objectKey: objectKeyToUse,
                    bucket,
                    fileType,
                    metadata: {
                        contentType: headResponse.ContentType,
                        contentLength: headResponse.ContentLength,
                        lastModified: headResponse.LastModified,
                        uploadedBy: headResponse.Metadata?.['uploaded-by'],
                        originalFilename: headResponse.Metadata?.['original-filename'],
                        uploadTimestamp: headResponse.Metadata?.['upload-timestamp']
                    },
                    expiresIn: 3600
                })
            };
        }
        catch (error) {
            if (error.name === 'NoSuchKey' || error.name === 'NotFound') {
                // Use the correctly scoped key in the log/response
                console.error(`S3 error: File not found for Key: ${objectKeyToUse} in Bucket: ${bucket}`);
                return {
                    statusCode: 404,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: 'File not found' })
                };
            }
            // Catch all other S3 errors (like permission issues) and return 500
            console.error('Unhandled S3 Error during Head/Get command:', error);
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: `Failed to retrieve file: ${error.message || 'Internal error'}` })
            };
        }
    }
    catch (error) {
        console.error('Error getting file URL:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
exports.handler = handler;