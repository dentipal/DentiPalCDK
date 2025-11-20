import {
    DynamoDBClient,
    ScanCommand,
    UpdateItemCommand,
    ScanCommandInput,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
    PutEventsCommandInput,
} from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";

const dynamo = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Helper Functions ---

type CognitoClaims = {
    "cognito:groups"?: string;
    "custom:clinicId"?: string;
    [key: string]: any; 
};

// Helper to read Cognito groups
function getCognitoGroups(event: any): string[] {
    // REST API (Lambda proxy)
    const claimsV1 = event?.requestContext?.authorizer?.claims as CognitoClaims;
    let groups: string =
        (typeof claimsV1?.["cognito:groups"] === "string"
            ? claimsV1["cognito:groups"]
            : "") || "";

    // HTTP API v2
    if (!groups) {
        const claimsV2 = event?.requestContext?.authorizer?.jwt?.claims as CognitoClaims;
        if (typeof claimsV2?.["cognito:groups"] === "string") {
            groups = claimsV2["cognito:groups"];
        }
    }

    return groups
        ? groups.split(",").map((g) => g.trim()).filter(Boolean)
        : [];
}

// Helper to get clinicId from Cognito claims
function getClinicIdFromEvent(event: any): string | null {
    // REST API v1
    const claimsV1 = event?.requestContext?.authorizer?.claims as CognitoClaims;
    if (claimsV1 && typeof claimsV1["custom:clinicId"] === "string") {
        return claimsV1["custom:clinicId"];
    }

    // HTTP API v2
    const claimsV2 = event?.requestContext?.authorizer?.jwt?.claims as CognitoClaims;
    if (claimsV2 && typeof claimsV2["custom:clinicId"] === "string") {
        return claimsV2["custom:clinicId"];
    }

    return null;
}

// Define the expected structure for the request body
interface RequestBody {
    professionalUserSub?: string;
    clinicId?: string;
    [key: string]: any;
}

// Define the handler function
export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
    try {
        console.log("Received event:", JSON.stringify(event));

        // --- CORS preflight ---
        const method: string =
            event.httpMethod || event.requestContext?.http?.method || "GET";
            
        if (method === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // Step 1: Authenticate Clinic
        const clinicUserSub: string = await validateToken(event);
        console.log("Authenticated clinic:", clinicUserSub);

        // Step 1.5 — Authorize by Cognito group
        const groups: string[] = getCognitoGroups(event);
        console.log("Caller groups:", groups);

        const ALLOWED: Set<string> = new Set(["Root", "ClinicAdmin", "ClinicManager"]);
        const isAllowed: boolean = groups.some((g) => ALLOWED.has(g));

        if (!isAllowed) {
            return json(403, {
                error: "Access denied: Only Root, ClinicAdmin, or ClinicManager can accept a professional."
            });
        }

        // Step 2: Extract jobId from path using proxy-style routing
        const proxyPath: string = event.pathParameters?.proxy || "";
        const pathSegments: string[] = proxyPath.split("/").filter(Boolean);
        let jobId: string | null = null;

        if (pathSegments.length >= 2 && pathSegments[0] === "jobs") {
            jobId = pathSegments[1];
        }

        console.log("📦 Extracted pathSegments:", pathSegments);
        console.log("🆔 Extracted jobId:", jobId);
        if (!jobId) {
            return json(400, { error: "Missing or invalid jobId in path" });
        }

        // Step 3: Parse body to get professionalUserSub
        const body: RequestBody = JSON.parse(event.body || "{}");
        const professionalUserSub: string | undefined = body.professionalUserSub;

        if (!professionalUserSub) {
            return json(400, { error: "Missing professionalUserSub in request body" });
        }

        // Step 4: Scan DentiPal-JobApplications for the matching application
        const scanCommandInput: ScanCommandInput = {
            TableName: "DentiPal-JobApplications",
            FilterExpression:
                "jobId = :jobId AND professionalUserSub = :professionalUserSub",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":professionalUserSub": { S: professionalUserSub }
            } as Record<string, AttributeValue>
        };

        const scanCommand = new ScanCommand(scanCommandInput);
        const scanResult = await dynamo.send(scanCommand);
        const matchingItem = scanResult.Items?.[0];

        if (!matchingItem) {
            return json(404, { error: "No matching application found" });
        }

        const applicationId: string | undefined = matchingItem.applicationId?.S;
        if (!applicationId) {
            return json(500, {
                error: "applicationId missing in application record"
            });
        }

        // Step 5: Update the application status to "scheduled"
        const updateCommandInput: UpdateItemCommandInput = {
            TableName: "DentiPal-JobApplications",
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            },
            UpdateExpression: "SET applicationStatus = :status, updatedAt = :now",
            ExpressionAttributeValues: {
                ":status": { S: "scheduled" },
                ":now": { S: new Date().toISOString() }
            } as Record<string, AttributeValue>
        };

        const updateCommand = new UpdateItemCommand(updateCommandInput);
        await dynamo.send(updateCommand);

        // ---- NEW: Step 6 — Emit EventBridge event to trigger chat system message ----
        const clinicIdFromClaims: string | null = getClinicIdFromEvent(event);
        const clinicId: string | null =
            clinicIdFromClaims ||
            body.clinicId || 
            matchingItem.clinicId?.S || null;

        if (!clinicId) {
            console.warn(
                "No clinicId found for EventBridge detail; system message will not fire"
            );
        } else {
            // Define a type for shift details
            interface ShiftDetails {
                date: string;
                role: string;
                rate: number;
            }

            const shiftDetails: ShiftDetails = {
                date: matchingItem.date?.S || "TBD",
                role:
                    matchingItem.role?.S ||
                    matchingItem.professionalRole?.S ||
                    "Professional",
                rate: matchingItem.proposedRate?.N
                    ? Number(matchingItem.proposedRate.N)
                    : 0
            };

            const putEventsCommandInput: PutEventsCommandInput = {
                Entries: [
                    {
                        Source: "denti-pal.api",
                        DetailType: "ShiftEvent",
                        Detail: JSON.stringify({
                            eventType: "shift-scheduled", 
                            clinicId,
                            professionalSub: professionalUserSub,
                            shiftDetails
                        })
                    }
                ]
            };

            await eb.send(new PutEventsCommand(putEventsCommandInput));

            console.log(
                `Published shift-scheduled for pro ${professionalUserSub} in clinic ${clinicId}`
            );
        }

        return json(200, {
            message: "Professional accepted and status updated to scheduled",
            jobId,
            professionalUserSub
        });
    } catch (error) {
        // Ensure error is treated as a standard Error object for message property
        const err = error as Error; 
        console.error("Error accepting professional:", err);
        return json(500, {
            error: err?.message || "Internal server error"
        });
    }
};