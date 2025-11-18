"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// CORS headers to be added to every response
const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // Allow requests from any origin
    "Access-Control-Allow-Credentials": true,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
};

const handler = async (event) => {
    console.log("📥 Incoming Event:", JSON.stringify(event, null, 2));

    try {
        // --- Auth ---
        let userSub;
        try {
            userSub = await validateToken(event);
            console.log("✅ User authenticated. userSub:", userSub);
        } catch (authErr) {
            console.warn("🚫 Token validation failed:", authErr);
            return {
                statusCode: 403,
                headers: corsHeaders,  // Add CORS headers here
                body: JSON.stringify({ error: "Forbidden: invalid or missing authorization" })
            };
        }

        // --- Extract clinicId from path ---
        const proxy = event.pathParameters?.proxy || "";
        const pathParts = proxy.split("/").filter(p => p);

        let clinicId;
        const markerIdx = pathParts.findIndex(p =>
            p.toLowerCase() === "clinics" || p.toLowerCase() === "clinictemporary"
        );
        if (markerIdx !== -1 && pathParts.length > markerIdx + 1) {
            clinicId = pathParts[markerIdx + 1];
        } else if (pathParts.length) {
            const last = pathParts[pathParts.length - 1];
            const uuidRegex = /^[0-9a-fA-F-]{36}$/;
            clinicId = uuidRegex.test(last) ? last : pathParts[0];
        }
        if (!clinicId && event.pathParameters?.clinicId) {
            clinicId = event.pathParameters.clinicId;
        }
        if (!clinicId && event.queryStringParameters?.clinicId) {
            clinicId = event.queryStringParameters.clinicId;
        }

        if (!clinicId) {
            return {
                statusCode: 400,
                headers: corsHeaders,  // Add CORS headers here
                body: JSON.stringify({ error: "clinicId is required in path or query string" })
            };
        }

        // --- Authorization check ---
        const groupsRaw = event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";
        const groups = Array.isArray(groupsRaw) ? groupsRaw : groupsRaw.split(",").map(g => g.trim()).filter(Boolean);
        const isRoot = groups.includes("Root");

        if (!isRoot) {
            const authProfileCommand = new GetItemCommand({
                TableName: process.env.CLINIC_PROFILES_TABLE,
                Key: {
                    clinicId: { S: clinicId },
                    userSub: { S: userSub }
                },
                ProjectionExpression: "clinicId, userSub"
            });
            const authProfileResp = await dynamodb.send(authProfileCommand);
            if (!authProfileResp.Item) {
                return {
                    statusCode: 403,
                    headers: corsHeaders,  // Add CORS headers here
                    body: JSON.stringify({ error: "Unauthorized: no access to this clinic's jobs" })
                };
            }
        }

        // --- Query jobs ---
        const queryCommand = new QueryCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            IndexName: "ClinicIdIndex",
            KeyConditionExpression: "clinicId = :clinicId",
            ExpressionAttributeValues: {
                ":clinicId": { S: clinicId },
                ":temporary": { S: "temporary" }
            },
            FilterExpression: "job_type = :temporary"
        });

        const result = await dynamodb.send(queryCommand);
        const allJobs = (result.Items || []).map(unmarshall);
        const temporaryJobs = allJobs.filter(job => job.job_type === "temporary");

        const formattedJobs = temporaryJobs.map(job => ({
            jobId: job.jobId || '',
            jobType: job.job_type || '',
            professionalRole: job.professional_role || '',
            jobTitle: job.job_title || '',
            description: job.job_description || '',
            requirements: job.requirements || [],
            date: job.date || '',
            startTime: job.start_time || '',
            endTime: job.end_time || '',
            hourlyRate: job.hourly_rate ? parseFloat(job.hourly_rate) : 0,
            mealBreak: job.meal_break || false,
            parkingInfo: job.parking_info || '',
            status: job.status || 'active',
            fullAddress: `${job.addressLine1 || ''} ${job.addressLine2 || ''} ${job.addressLine3 || ''}`.trim(),
            city: job.city || '',
            state: job.state || '',
            pincode: job.pincode || '',
            createdAt: job.createdAt || '',
            updatedAt: job.updatedAt || ''
        }));

        return {
            statusCode: 200,
            headers: corsHeaders,  // Add CORS headers here
            body: JSON.stringify({
                message: `Retrieved ${formattedJobs.length} temporary job(s) for clinicId: ${clinicId}`,
                jobs: formattedJobs
            })
        };
    } catch (error) {
        console.error("❌ Error during Lambda execution:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,  // Add CORS headers here
            body: JSON.stringify({
                error: "Failed to retrieve temporary jobs",
                details: error.message
            })
        };
    }
};

exports.handler = handler;
