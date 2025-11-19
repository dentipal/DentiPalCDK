import {
    DynamoDBClient,
    ScanCommand,
    UpdateItemCommand,
    ScanCommandInput,
    UpdateItemCommandInput,
    AttributeValue,
    GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
    PutEventsCommandInput,
} from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyEventV2, APIGatewayProxyResult } from "aws-lambda";

// Assuming utils.ts contains a definition for validateToken
// The actual file is not provided, so we'll use a placeholder function signature.
// declare function validateToken(event: any): Promise<string>;
// To make the code compile without the actual file, we'll import it from a placeholder:
import { validateToken } from "./utils";


// --- Initialization ---

// Use AWS_REGION if available, else REGION, else default
const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";

const dynamo = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

// Define the type for CORS headers for reuse
type CorsHeaders = { [header: string]: string | number | boolean };

// Reusable CORS headers
const corsHeaders: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,PATCH,DELETE",
    "Content-Type": "application/json"
};

// Helper to build JSON responses with CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(bodyObj)
});

// --- Helper Functions ---

// Define a type for the Cognito claims structure
type CognitoClaims = {
    "cognito:groups"?: string;
    "custom:clinicId"?: string;
    [key: string]: any; // Allow other properties
};

// Helper to read Cognito groups
function getCognitoGroups(event: any): string[] {
    // REST API (Lambda proxy) -> event.requestContext.authorizer.claims['cognito:groups']
    const claimsV1 = event?.requestContext?.authorizer?.claims as CognitoClaims;
    let groups: string =
        (typeof claimsV1?.["cognito:groups"] === "string"
            ? claimsV1["cognito:groups"]
            : "") || "";

    // HTTP API v2 -> event.requestContext.authorizer.jwt.claims['cognito:groups']
    if (!groups) {
        const claimsV2 = event?.requestContext?.authorizer?.jwt?.claims as CognitoClaims;
        if (typeof claimsV2?.["cognito:groups"] === "string") {
            groups = claimsV2["cognito:groups"];
        }
    }

    // Groups come as comma-separated string when present
    return groups
        ? groups.split(",").map((g) => g.trim()).filter(Boolean)
        : [];
}

// NEW: helper to get clinicId from Cognito claims
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

        // --- CORS preflight (supports REST API and HTTP API v2) ---
        const method: string =
            event.httpMethod || event.requestContext?.http?.method || "GET";
        if (method === "OPTIONS") {
            // No body for preflight
            return { statusCode: 204, headers: corsHeaders, body: "" };
        }

        // Step 1: Authenticate Clinic
        const clinicUserSub: string = await validateToken(event);
        console.log("Authenticated clinic:", clinicUserSub);

        // Step 1.5 — Authorize by Cognito group
        const groups: string[] = getCognitoGroups(event);
        console.log("Caller groups:", groups);

        // Allow only Root, ClinicAdmin, ClinicManager
        const ALLOWED: Set<string> = new Set(["Root", "ClinicAdmin", "ClinicManager"]);
        const isAllowed: boolean = groups.some((g) => ALLOWED.has(g));

        if (!isAllowed) {
            // Explicit denial message for ClinicViewer or any other group
            return json(403, {
                error:
                    "Access denied: Only Root, ClinicAdmin, or ClinicManager can accept a professional."
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
            body.clinicId || // fallback if you ever send clinicId in body
            matchingItem.clinicId?.S || null; // fallback if stored on the application

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
                            eventType: "shift-scheduled", // 👈 system-message lambda listens for this
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