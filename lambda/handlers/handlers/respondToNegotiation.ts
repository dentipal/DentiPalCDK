import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
    GetItemCommand,
    AttributeValue,
    DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    APIGatewayProxyEvent, // Include V1 for broader compatibility if path parsing logic assumes V1
} from "aws-lambda";

// Assuming this utility file exports the validateToken function
import { validateToken } from "./utils"; 

// --- Type Definitions ---

// Define the core structure for DynamoDB Items
type DynamoDBItem = { [key: string]: AttributeValue | undefined };

// Define the expected structure of the request body payload
interface NegotiationResponsePayload {
    response: "accepted" | "declined" | "counter_offer";
    message?: string;
    // Permanent job counter offer fields
    counterSalaryMin?: number;
    counterSalaryMax?: number;
    // Hourly job counter offer fields
    clinicCounterHourlyRate?: number;
    professionalCounterHourlyRate?: number;
}

// Define the expected Negotiation Status types
type NegotiationStatus = "accepted" | "declined" | "counter_offer" | "pending";

// Define the expected Actor types
type Actor = "clinic" | "professional";

/** Standard response format for API Gateway V2 Lambda integration */
type HandlerResponse = APIGatewayProxyResultV2;


// --- Constants and Initialization ---

// Use non-null assertion (!) as we expect this environment variable to be set.
const REGION: string = process.env.REGION!; 

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);

// Valid responses for request body validation
const VALID_RESPONSES: ReadonlyArray<NegotiationResponsePayload['response']> = ["accepted", "declined", "counter_offer"];

// ---- CORS Headers ----
const getCorsHeaders = (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): { [header: string]: string } => {
    // Attempt to determine origin dynamically (though often '*' is used in dev/staging)
    const origin = (event as APIGatewayProxyEventV2)?.headers?.origin || (event as APIGatewayProxyEvent)?.headers?.Origin || "*";
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
            "Content-Type,Authorization,X-Requested-With",
        "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
        "Access-Control-Allow-Credentials": "true",
        "Vary": "Origin",
    };
};

// ---- DynamoDB Attribute Helpers ----

/** Converts a DynamoDB AttributeValue (N or S) to a number, or null if invalid. */
const numFrom = (val: AttributeValue | undefined): number | null => {
    if (!val) return null;
    if (typeof val.N === "string") return Number(val.N);
    
    // Original JS logic included a broad string conversion, maintaining for parity
    if (typeof val.S === "string" && val.S.trim() !== "" && !isNaN(+val.S))
        return Number(val.S);
    
    return null;
};

/** Converts a DynamoDB AttributeValue (S or N) to a string, or null if invalid. */
const strFrom = (val: AttributeValue | undefined): string | null => {
    if (!val) return null;
    if (typeof val.S === "string") return val.S;
    if (typeof val.N === "string") return val.N;
    return null;
};

/** Extracts a proposed hourly rate from an application item using common attribute names. */
const getAppProposedRate = (appItem: DynamoDBItem | undefined): number | null => {
    if (!appItem) return null;
    return (
        numFrom(appItem.proposedRate) ??
        numFrom(appItem.proposedHourlyRate) ??
        numFrom(appItem.hourlyProposedRate) ??
        numFrom(appItem.rate) ??
        null
    );
};


// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
    const headers = getCorsHeaders(event);

    // Handle CORS preflight
    if (event.requestContext.http.method === "OPTIONS") {
        return { statusCode: 200, headers, body: "" };
    }

    try {
        // 1. Authentication and Body Parsing
        // We cast event to 'any' here if `validateToken` is expected to handle V1 or V2 events interchangeably.
        const userSub: string = await validateToken(event as any); 
        const body: NegotiationResponsePayload = JSON.parse(event.body || "{}");

        // 2. Path Parsing (Note: Using event.path as per original JS, even if V2 uses rawPath)
        // path: /applications/{applicationId}/negotiations/{negotiationId}/response
        const path: string = event.path || "";
        const parts: string[] = path.split("/"); 
        
        // This relies on the path structure being exactly what's expected by the API Gateway configuration
        const applicationId: string | undefined = parts[2];
        const negotiationId: string | undefined = parts[4]; 

        if (!applicationId || !negotiationId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: "applicationId and negotiationId are required in path",
                }),
            };
        }

        if (!body.response || !VALID_RESPONSES.includes(body.response)) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error:
                        `'response' is required and must be one of: ${VALID_RESPONSES.join(", ")}`,
                }),
            };
        }

        // 3. Load Negotiation Item
        const negotiationRes = await dynamodb.send(
            new GetItemCommand({
                TableName: process.env.JOB_NEGOTIATIONS_TABLE!,
                Key: {
                    applicationId: { S: applicationId },
                    negotiationId: { S: negotiationId },
                },
            })
        );

        if (!negotiationRes.Item) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Negotiation not found" }),
            };
        }

        const negotiationItem: DynamoDBItem = negotiationRes.Item;
        const jobId: string | null = strFrom(negotiationItem.jobId);

        // 4. Load Job Item (to get job type and clinic owner)
        if (!jobId) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: "Negotiation data is invalid (missing jobId)" }) };
        }

        const jobRes = await dynamodb.send(
            new QueryCommand({
                TableName: process.env.JOB_POSTINGS_TABLE!,
                IndexName: "JobIdIndex", // Assuming JobIdIndex is the GSI name
                KeyConditionExpression: "jobId = :jobId",
                ExpressionAttributeValues: {
                    ":jobId": { S: jobId },
                },
            })
        );

        if (!jobRes.Items || jobRes.Items.length === 0) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Job not found or no permission" }),
            };
        }

        const jobItem: DynamoDBItem = jobRes.Items[0];
        const jobType: string | null = strFrom(jobItem.job_type) || strFrom(jobItem.jobType);
        const clinicUserSub: string | null =
            strFrom(jobItem.clinicUserSub) || strFrom(jobItem.createdBy);

        // 5. Load Application Item (to get professional user sub)
        const appRes = await dynamodb.send(
            new QueryCommand({
                TableName: process.env.JOB_APPLICATIONS_TABLE!,
                IndexName: "applicationId-index", // Assuming applicationId-index is the GSI name
                KeyConditionExpression: "applicationId = :applicationId",
                ExpressionAttributeValues: {
                    ":applicationId": { S: applicationId },
                },
            })
        );

        if (!appRes.Items || appRes.Items.length === 0) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Application not found" }),
            };
        }

        const appItem: DynamoDBItem = appRes.Items[0];
        const professionalUserSub: string | null = strFrom(appItem.professionalUserSub);

        // 6. Determine Actor (Authorization)
        let actor: Actor | null = null;
        if (userSub === clinicUserSub) {
            actor = "clinic";
        } else if (userSub === professionalUserSub) {
            actor = "professional";
        }

        if (!actor) {
            return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                    error: "Not authorized for this negotiation. Caller is neither clinic owner nor professional applicant.",
                }),
            };
        }

        const timestamp: string = new Date().toISOString();
        
        // 7. Validate Counter Offer Payload
        if (body.response === "counter_offer") {
            const isPermanent = (jobType || "").toLowerCase() === "permanent";
            
            if (isPermanent) {
                if (typeof body.counterSalaryMin !== "number" || typeof body.counterSalaryMax !== "number") {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({
                            error: "counterSalaryMin and counterSalaryMax are required for permanent job counter offers",
                        }),
                    };
                }
                if (body.counterSalaryMax < body.counterSalaryMin) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: "counterSalaryMax must be greater than counterSalaryMin" }),
                    };
                }
            } else { // Hourly/Temporary jobs
                if (typeof body.clinicCounterHourlyRate !== "number" && typeof body.professionalCounterHourlyRate !== "number") {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({
                            error: "clinicCounterHourlyRate or professionalCounterHourlyRate is required for hourly job counter offers",
                        }),
                    };
                }
            }
        }

        // 8. Build Negotiation Update Command
        const isAccepted = body.response === "accepted";
        const isDeclined = body.response === "declined";
        const isCounter = body.response === "counter_offer";

        const attrNames: { [key: string]: string } = {
            "#status": "negotiationStatus",
            "#updatedAt": "updatedAt",
        };
        const attrValues: { [key: string]: AttributeValue } = {
            ":status": { S: body.response },
            ":updatedAt": { S: timestamp },
        };
        let updateExpr: string = "SET #status = :status, #updatedAt = :updatedAt";

        // Actor-specific response fields
        if (actor === "clinic") {
            attrNames["#actorResponse"] = "clinicResponse";
            attrNames["#actorMessage"] = "clinicMessage";
            attrNames["#actorRespondedAt"] = "clinicRespondedAt";
        } else {
            attrNames["#actorResponse"] = "professionalResponse";
            attrNames["#actorMessage"] = "professionalMessage";
            attrNames["#actorRespondedAt"] = "professionalRespondedAt";
        }
        attrValues[":actorResponse"] = { S: body.response };
        attrValues[":actorMessage"] = { S: body.message || "" };
        attrValues[":actorRespondedAt"] = { S: timestamp };
        updateExpr +=
            ", #actorResponse = :actorResponse, #actorMessage = :actorMessage, #actorRespondedAt = :actorRespondedAt";

        // Attach hourly counter rates to the negotiation item
        if (typeof body.clinicCounterHourlyRate === "number") {
            attrNames["#clinicCounterHourlyRate"] = "clinicCounterHourlyRate";
            attrValues[":clinicCounterHourlyRate"] = { N: String(body.clinicCounterHourlyRate) };
            updateExpr += ", #clinicCounterHourlyRate = :clinicCounterHourlyRate";
        }
        if (typeof body.professionalCounterHourlyRate === "number") {
            attrNames["#professionalCounterHourlyRate"] = "professionalCounterHourlyRate";
            attrValues[":professionalCounterHourlyRate"] = { N: String(body.professionalCounterHourlyRate) };
            updateExpr += ", #professionalCounterHourlyRate = :professionalCounterHourlyRate";
        }
        
        // Attach salary counter rates to the negotiation item
        if (isCounter && (jobType || "").toLowerCase() === "permanent") {
             // Assuming the DB fields are 'proposedSalaryMin' and 'proposedSalaryMax'
             // If the schema requires specific 'counter' fields, they should be used here instead.
             attrNames["#counterSalaryMin"] = "counterSalaryMin";
             attrNames["#counterSalaryMax"] = "counterSalaryMax";
             attrValues[":counterSalaryMin"] = { N: String(body.counterSalaryMin!) };
             attrValues[":counterSalaryMax"] = { N: String(body.counterSalaryMax!) };
             updateExpr += ", #counterSalaryMin = :counterSalaryMin, #counterSalaryMax = :counterSalaryMax";
        }


        // Determine final accepted hourly rate (for hourly jobs only)
        let finalAcceptedHourlyRate: number | null = null;

        if (isAccepted && (jobType || "").toLowerCase() !== "permanent") {
            const clinicCounter = numFrom(negotiationItem.clinicCounterHourlyRate) ?? body.clinicCounterHourlyRate ?? null;
            const professionalCounter = numFrom(negotiationItem.professionalCounterHourlyRate) ?? body.professionalCounterHourlyRate ?? null;

            if (actor === "professional") {
                // Professional accepts -> agree to clinic's counter (if present)
                if (clinicCounter == null) {
                    return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: "Cannot accept: no clinicCounterHourlyRate to accept." }),
                    };
                }
                finalAcceptedHourlyRate = clinicCounter;
            } else { // actor === "clinic"
                // Clinic accepts -> agree to professional's counter or original application proposal
                const appProposed = getAppProposedRate(appItem);
                
                if (professionalCounter != null) {
                    finalAcceptedHourlyRate = professionalCounter;
                } else if (appProposed != null) {
                    finalAcceptedHourlyRate = appProposed;
                } else {
                     return {
                        statusCode: 400,
                        headers,
                        body: JSON.stringify({ error: "Cannot accept: no professional counter rate or original proposed rate found." }),
                    };
                }
            }

            // Write a canonical agreed rate to negotiation row
            if (finalAcceptedHourlyRate != null) {
                attrNames["#agreedHourlyRate"] = "agreedHourlyRate";
                attrValues[":agreedHourlyRate"] = { N: String(finalAcceptedHourlyRate) };
                updateExpr += ", #agreedHourlyRate = :agreedHourlyRate";
            }
        }

        // Execute negotiation update
        await dynamodb.send(
            new UpdateItemCommand({
                TableName: process.env.JOB_NEGOTIATIONS_TABLE!,
                Key: {
                    applicationId: { S: applicationId },
                    negotiationId: { S: negotiationId },
                },
                UpdateExpression: updateExpr,
                ExpressionAttributeNames: attrNames,
                ExpressionAttributeValues: attrValues,
            })
        );

        // 9. Update Application Status
        let applicationStatus: "negotiating" | "scheduled" | "declined" = "negotiating";
        if (isAccepted) applicationStatus = "scheduled";
        else if (isDeclined) applicationStatus = "declined";
        // If it's a counter-offer, status remains "negotiating"

        const appUpdateNames: { [key: string]: string } = {
            "#status": "applicationStatus",
            "#updatedAt": "updatedAt",
        };
        const appUpdateValues: { [key: string]: AttributeValue } = {
            ":status": { S: applicationStatus },
            ":updatedAt": { S: timestamp },
        };
        let appUpdateExpr: string = "SET #status = :status, #updatedAt = :updatedAt";

        if (finalAcceptedHourlyRate != null) {
            // Set both keys for compatibility with your FE/backends
            appUpdateNames["#acceptedHourlyRate"] = "acceptedHourlyRate";
            appUpdateNames["#acceptedRate"] = "acceptedRate";
            appUpdateValues[":acceptedHourlyRate"] = { N: String(finalAcceptedHourlyRate) };
            appUpdateValues[":acceptedRate"] = { N: String(finalAcceptedHourlyRate) };
            appUpdateExpr += ", #acceptedHourlyRate = :acceptedHourlyRate, #acceptedRate = :acceptedRate";
        }
        
        // Final application update
        if (!professionalUserSub) {
             throw new Error("Cannot update application: professionalUserSub is missing.");
        }

        await dynamodb.send(
            new UpdateItemCommand({
                TableName: process.env.JOB_APPLICATIONS_TABLE!,
                Key: {
                    jobId: { S: jobId },
                    // This is the Primary/Sort Key of the application table, which is 
                    // the professional's ID for that application.
                    professionalUserSub: { S: professionalUserSub }, 
                },
                UpdateExpression: appUpdateExpr,
                ExpressionAttributeNames: appUpdateNames,
                ExpressionAttributeValues: appUpdateValues,
            })
        );

        // 10. Success Response
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                message: `Negotiation ${body.response} successfully`,
                negotiationId,
                applicationId,
                jobId,
                actor, 
                response: body.response,
                applicationStatus,
                acceptedHourlyRate: finalAcceptedHourlyRate ?? undefined,
                respondedAt: timestamp,
                nextSteps: isAccepted
                    ? "Job has been scheduled with negotiated terms."
                    : isCounter
                    ? "Counter-offer sent; the other party will review."
                    : "Negotiation declined.",
            }),
        };
    } catch (error) {
        console.error("Error responding to negotiation:", error);
        
        // Safely access the message property of the error object
        const errorMessage: string = (error as Error).message || "An unknown error occurred";
        
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};