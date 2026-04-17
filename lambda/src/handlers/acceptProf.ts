import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyResult, APIGatewayProxyEvent } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// --- Initialization ---
const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;

const dynamo = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

function getClinicIdFromEvent(event: any): string | null {
    const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;
    if (claims && typeof claims["custom:clinicId"] === "string") {
        return claims["custom:clinicId"];
    }
    return null;
}

interface RequestBody {
    professionalUserSub?: string;
    professional_user_sub?: string;
    clinicId?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    try {
        // 🔍 DEBUG LOGS
        console.log("--- DEBUG START ---");
        console.log("HTTP Method:", event.httpMethod);
        console.log("Path Params:", event.pathParameters);
        console.log("Raw Body Type:", typeof event.body);
        
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // --- Step 1: Authentication ---
        let clinicUserSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            clinicUserSub = userInfo.sub;
            
            const groups: string[] = userInfo.groups || [];
            const ALLOWED = new Set(["root", "clinicadmin", "clinicmanager"]);
            const isAllowed = groups.some((g) => ALLOWED.has(g.toLowerCase()));

            if (!isAllowed) {
                return json(403, { error: "Access denied: Unauthorized group." });
            }
        } catch (authError: any) {
            console.error("Authentication failed:", authError.message);
            return json(401, { error: authError.message || "Invalid access token" });
        }

        // --- Step 2: Extract Job ID ---
        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
            const pathParts = event.pathParameters.proxy.split('/');
            const jobsIndex = pathParts.indexOf("jobs");
            if (jobsIndex !== -1 && pathParts.length > jobsIndex + 1) {
                jobId = pathParts[jobsIndex + 1];
            } else {
                jobId = pathParts[pathParts.length - 1];
            }
        }

        if (!jobId) {
            return json(400, { error: "Missing or invalid jobId in path" });
        }

        // --- ✅ Step 3: Parse Request Body (STRICT CHECK) ---
        let body: RequestBody = {};
        let bodyString = event.body;

        // 🛑 FIX 1: Fail fast if body is completely missing
        if (bodyString === null || bodyString === undefined || bodyString === "") {
             console.error("❌ ERROR: Body is null or empty string");
             return json(400, { 
                 error: "Request body is empty", 
                 hint: "Ensure you are sending JSON in the request body, not as Query Params." 
             });
        }

        if (event.isBase64Encoded && bodyString) {
            bodyString = Buffer.from(bodyString, 'base64').toString('utf-8');
        }

        if (typeof bodyString === 'string') {
            try {
                body = JSON.parse(bodyString);
            } catch (e) {
                return json(400, { error: "Invalid JSON format in body", rawBody: bodyString });
            }
        } else if (typeof bodyString === 'object') {
            body = bodyString;
        }

        console.log("Parsed Body:", JSON.stringify(body));

        const professionalUserSub = body.professionalUserSub || body.professional_user_sub;

        if (!professionalUserSub) {
            return json(400, { 
                error: "Missing professionalUserSub in request body",
                details: { receivedKeys: Object.keys(body) }
            });
        }

        // --- Step 4: Validate Application Exists ---
        const getCommand = new GetItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            }
        });

        const getResult = await dynamo.send(getCommand);
        const matchingItem = getResult.Item;

        if (!matchingItem) {
            return json(404, { error: "No matching application found" });
        }

        // --- Step 5: Update Status ---
        const updateCommandInput: UpdateItemCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            },
            UpdateExpression: "SET applicationStatus = :status, updatedAt = :now",
            ExpressionAttributeValues: {
                ":status": { S: "scheduled" },
                ":now": { S: new Date().toISOString() }
            }
        };

        await dynamo.send(new UpdateItemCommand(updateCommandInput));

        // --- Step 6: Emit EventBridge Event (triggers inbox conversation) ---
        const clinicIdFromClaims = getClinicIdFromEvent(event);
        const clinicId = clinicIdFromClaims || body.clinicId || matchingItem.clinicId?.S || null;

        let inboxMessageSent = false;

        // Fetch the actual job posting for shift details
        let jobItem: Record<string, any> | null = null;
        if (clinicId) {
            try {
                const jobRes = await dynamo.send(new QueryCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    IndexName: "jobId-index-1",
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: jobId } },
                    Limit: 1,
                }));
                jobItem = (jobRes.Items || [])[0] || null;
            } catch (e) {
                console.warn("Failed to fetch job posting for shift details:", (e as Error).message);
            }
        }

        if (clinicId) {
            const shiftDate = jobItem?.date?.S || jobItem?.start_date?.S || matchingItem.date?.S || "TBD";
            const shiftRole = jobItem?.professional_role?.S || matchingItem.role?.S || matchingItem.professionalRole?.S || "Professional";
            const shiftRate = matchingItem.proposedRate?.N ? Number(matchingItem.proposedRate.N)
                : (jobItem?.rate?.N ? Number(jobItem.rate.N) : 0);
            const shiftStartTime = jobItem?.start_time?.S || "";
            const shiftEndTime = jobItem?.end_time?.S || "";
            const shiftLocation = jobItem?.city?.S || jobItem?.fullAddress?.S || "";
            const jobType = jobItem?.job_type?.S || "";

            // Format date nicely
            let formattedDate = shiftDate;
            try {
                const d = new Date(shiftDate);
                if (!isNaN(d.getTime())) {
                    formattedDate = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                }
            } catch {}

            const shiftDetails = {
                date: formattedDate,
                role: shiftRole.split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
                rate: shiftRate,
                startTime: shiftStartTime,
                endTime: shiftEndTime,
                location: shiftLocation,
                jobType,
            };

            await eb.send(new PutEventsCommand({
                Entries: [{
                    Source: "denti-pal.api",
                    DetailType: "ShiftEvent",
                    Detail: JSON.stringify({
                        eventType: "shift-scheduled",
                        clinicId,
                        professionalSub: professionalUserSub,
                        shiftDetails
                    })
                }]
            }));
            inboxMessageSent = true;
        } else {
            console.error("WARNING: clinicId is missing — inbox conversation will NOT be created.", {
                jobId,
                professionalUserSub,
                clinicIdFromClaims,
                bodyClinicId: body.clinicId,
                itemClinicId: matchingItem.clinicId?.S,
            });
        }

        return json(200, {
            message: "Professional accepted and status updated to scheduled",
            jobId,
            professionalUserSub,
            inboxMessageSent,
            ...(inboxMessageSent ? {} : { warning: "clinicId not found — inbox conversation was not created. Provide clinicId in the request body or ensure it exists in the job application." }),
        });

    } catch (error: any) {
        console.error("Error in handler:", error);
        return json(500, { error: error.message || "Internal server error" });
    }
};