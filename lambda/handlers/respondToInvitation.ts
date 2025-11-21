// Imports from AWS SDK
import {
    DynamoDBClient,
    QueryCommand,
    PutItemCommand,
    UpdateItemCommand,
    DynamoDBClientConfig,
    AttributeValue, // Type for DynamoDB attribute values
} from "@aws-sdk/client-dynamodb";
// Imports for AWS Lambda types
import {
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
} from "aws-lambda";
// External utilities
import { extractUserFromBearerToken } from "./utils"; 
import { v4 as uuidv4 } from "uuid"; // Assuming uuid package is installed

// --- Type Definitions ---

/** Defines the expected structure of the request body for responding to an invitation. */
interface InvitationResponseData {
    response: "accepted" | "declined" | "negotiating";
    message?: string;
    // Negotiation fields
    proposedHourlyRate?: number;
    proposedSalaryMin?: number;
    proposedSalaryMax?: number;
    availabilityNotes?: string;
    counterProposalMessage?: string;
}

/** Defines the structure of a single DynamoDB item (Invitation). */
interface InvitationItem {
    invitationId?: AttributeValue;
    professionalUserSub?: AttributeValue;
    jobId?: AttributeValue;
    clinicUserSub?: AttributeValue;
    clinicId?: AttributeValue;
    invitationStatus?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

/** Defines the structure of a single DynamoDB item (Job). */
interface JobItem {
    job_type?: AttributeValue;
    status?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

/** Standard response format for API Gateway V2 Lambda integration */
type HandlerResponse = APIGatewayProxyResultV2;


// --- Constants and Initialization ---

// Use non-null assertion (!) as we expect these environment variables to be set.
const REGION: string = process.env.REGION!;
const JOB_INVITATIONS_TABLE: string = process.env.JOB_INVITATIONS_TABLE!;
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!;
const JOB_APPLICATIONS_TABLE: string = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_NEGOTIATIONS_TABLE: string = process.env.JOB_NEGOTIATIONS_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);

import { CORS_HEADERS } from "./corsHeaders";

const VALID_RESPONSES: ReadonlyArray<InvitationResponseData['response']> = ["accepted", "declined", "negotiating"];

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
    
    // Handle CORS preflight
    if (event.requestContext.http.method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        
        console.log("Authenticated userSub from token:", userSub);

        // 2. Extract invitationId from path
        const path: string = event.rawPath || ""; // Use rawPath for V2
        // Regex to match: /invitations/<invitationId>/response
        const match = path.match(/\/invitations\/([^/]+)\/response/);
        const invitationId: string | undefined = match?.[1];

        if (!invitationId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "invitationId is required in path" }),
            };
        }

        // 3. Parse and Validate Request Body
        const responseData: InvitationResponseData = JSON.parse(event.body || "{}");

        if (!responseData.response || !VALID_RESPONSES.includes(responseData.response)) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: `Invalid or missing 'response' field. Valid options: ${VALID_RESPONSES.join(", ")}` }),
            };
        }

        // 4. Fetch Invitation
        const invitationQuery = await dynamodb.send(
            new QueryCommand({
                TableName: JOB_INVITATIONS_TABLE,
                IndexName: "invitationId-index",
                KeyConditionExpression: "invitationId = :invId",
                ExpressionAttributeValues: {
                    ":invId": { S: invitationId },
                },
            })
        );

        const invitation: InvitationItem | undefined = invitationQuery.Items?.[0];

        if (!invitation) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Invitation not found" }),
            };
        }

        const professionalUserSub: string | undefined = invitation.professionalUserSub?.S;
        const jobId: string | undefined = invitation.jobId?.S;
        const clinicUserSub: string | undefined = invitation.clinicUserSub?.S;
        const clinicId: string | undefined = invitation.clinicId?.S;

        // 5. Authorization & State Check
        if (professionalUserSub !== userSub) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "You can only respond to your own invitations" }),
            };
        }

        if (!jobId || !clinicUserSub || !clinicId) {
            return {
                statusCode: 500,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Invalid invitation data - missing jobId, clinicUserSub, or clinicId" }),
            };
        }
        
        const currentStatus = invitation.invitationStatus?.S;
        if (currentStatus === "accepted" || currentStatus === "declined") {
            return {
                statusCode: 409,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: `Invitation has already been ${currentStatus}` }),
            };
        }

        // 6. Fetch Job Details
        const jobQuery = await dynamodb.send(
            new QueryCommand({
                TableName: JOB_POSTINGS_TABLE,
                IndexName: "jobId-index", // Ensure this GSI name is correct
                KeyConditionExpression: "jobId = :jobId",
                ExpressionAttributeValues: {
                    ":jobId": { S: jobId },
                },
            })
        );

        const job: JobItem | undefined = jobQuery.Items?.[0];

        if (!job) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Job not found" }),
            };
        }

        // --- 7. Process Response and Conditional Logic ---
        const timestamp: string = new Date().toISOString();
        let applicationId: string | null = null;
        const jobType: string | undefined = job.job_type?.S;
        
        if (responseData.response === "accepted") {
            // A. Accepted Logic: Create Application and update job/invitation status
            applicationId = uuidv4();
            
            // Create Application Item
            await dynamodb.send(
                new PutItemCommand({
                    TableName: JOB_APPLICATIONS_TABLE,
                    Item: {
                        applicationId: { S: applicationId },
                        jobId: { S: jobId },
                        professionalUserSub: { S: userSub },
                        clinicUserSub: { S: clinicUserSub },
                        clinicId: { S: clinicId },
                        applicationStatus: { S: "accepted" },
                        appliedAt: { S: timestamp },
                        updatedAt: { S: timestamp },
                        applicationMessage: { S: responseData.message || "Application submitted via invitation" },
                        fromInvitation: { BOOL: true },
                        invitationResponseDate: { S: timestamp },
                    },
                })
            );

            // Update Job Posting status (assuming 'scheduled' is the goal for an accepted job)
            if (job.status?.S === "open") {
                await dynamodb.send(
                    new UpdateItemCommand({
                        TableName: JOB_POSTINGS_TABLE, // Update the job posting item
                        Key: {
                            jobId: { S: jobId },
                            // Assuming the GSI result has the original PK/SK for the Job
                            clinicId: { S: clinicId }, 
                        },
                        UpdateExpression:
                            "SET #status = :status, #acceptedProfessional = :professional, #updatedAt = :updatedAt",
                        ExpressionAttributeNames: {
                            "#status": "status",
                            "#acceptedProfessional": "acceptedProfessionalUserSub",
                            "#updatedAt": "updatedAt",
                        },
                        ExpressionAttributeValues: {
                            ":status": { S: "scheduled" },
                            ":professional": { S: userSub },
                            ":updatedAt": { S: timestamp },
                        },
                    })
                );
            }
        } 
        
        else if (responseData.response === "negotiating") {
            // B. Negotiating Logic: Validate proposal, create Application, create Negotiation
            
            // --- Negotiation Validation ---
            if (jobType === "permanent") {
                if (responseData.proposedSalaryMin == null || responseData.proposedSalaryMax == null) {
                    return {
                        statusCode: 400,
                        headers: CORS_HEADERS,
                        body: JSON.stringify({ error: "proposedSalaryMin and proposedSalaryMax are required for permanent job negotiations" }),
                    };
                }
                if (Number(responseData.proposedSalaryMax) < Number(responseData.proposedSalaryMin)) {
                    return {
                        statusCode: 400,
                        headers: CORS_HEADERS,
                        body: JSON.stringify({ error: "proposedSalaryMax must be greater than proposedSalaryMin" }),
                    };
                }
            } else { // Hourly/Temp
                if (responseData.proposedHourlyRate == null) {
                    return {
                        statusCode: 400,
                        headers: CORS_HEADERS,
                        body: JSON.stringify({ error: "proposedHourlyRate is required for hourly job negotiations" }),
                    };
                }
            }
            // --- End Validation ---
            
            applicationId = uuidv4();

            // 1. Create Application Item (Status: negotiating)
            const applicationItem: any = { // Using `any` for dynamic properties
                applicationId: { S: applicationId },
                jobId: { S: jobId },
                professionalUserSub: { S: userSub },
                clinicUserSub: { S: clinicUserSub },
                clinicId: { S: clinicId },
                applicationStatus: { S: "negotiating" },
                appliedAt: { S: timestamp },
                updatedAt: { S: timestamp },
                applicationMessage: { S: responseData.message || "Application submitted with counter-proposal" },
                fromInvitation: { BOOL: true },
                invitationResponseDate: { S: timestamp },
            };

            if (responseData.availabilityNotes) {
                applicationItem.availabilityNotes = { S: responseData.availabilityNotes };
            }

            await dynamodb.send(new PutItemCommand({
                TableName: JOB_APPLICATIONS_TABLE,
                Item: applicationItem,
            }));

            // 2. Create Negotiation Item
            const negotiationId = uuidv4();
            
            const negotiationItem: any = { // Using `any` for dynamic properties
                applicationId: { S: applicationId },
                negotiationId: { S: negotiationId },
                jobId: { S: jobId },
                fromType: { S: "professional" },
                fromUserSub: { S: userSub },
                toUserSub: { S: clinicUserSub },
                clinicId: { S: clinicId },
                negotiationStatus: { S: "pending" },
                createdAt: { S: timestamp },
                updatedAt: { S: timestamp },
                message: { S: responseData.counterProposalMessage || "Counter-proposal submitted" },
            };

            if (jobType === "permanent") {
                negotiationItem.proposedSalaryMin = { N: String(responseData.proposedSalaryMin) };
                negotiationItem.proposedSalaryMax = { N: String(responseData.proposedSalaryMax) };
            } else {
                negotiationItem.proposedHourlyRate = { N: String(responseData.proposedHourlyRate) };
            }

            await dynamodb.send(new PutItemCommand({
                TableName: JOB_NEGOTIATIONS_TABLE,
                Item: negotiationItem,
            }));
        } 
        
        // C. Declined Logic: No new records needed, only update invitation status.

        // 8. Update Invitation Status (Final Step for all responses)
        await dynamodb.send(
            new UpdateItemCommand({
                TableName: JOB_INVITATIONS_TABLE,
                Key: {
                    jobId: { S: jobId },
                    professionalUserSub: { S: professionalUserSub },
                },
                UpdateExpression:
                    "SET #status = :status, #respondedAt = :respondedAt, #responseMessage = :message, #updatedAt = :updatedAt",
                ExpressionAttributeNames: {
                    "#status": "invitationStatus",
                    "#respondedAt": "respondedAt",
                    "#responseMessage": "responseMessage",
                    "#updatedAt": "updatedAt",
                },
                ExpressionAttributeValues: {
                    ":status": { S: responseData.response },
                    ":respondedAt": { S: timestamp },
                    ":message": { S: responseData.message || "" },
                    ":updatedAt": { S: timestamp },
                },
            })
        );

        // 9. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: `Invitation ${responseData.response} successfully`,
                invitationId,
                jobId,
                response: responseData.response,
                applicationId,
                respondedAt: timestamp,
                jobType: jobType,
                nextSteps:
                    responseData.response === "accepted"
                        ? "Job has been scheduled. Wait for clinic confirmation."
                        : responseData.response === "negotiating"
                        ? "Negotiation started. Clinic will review your proposal."
                        : "Invitation declined. Thank you for your response.",
            }),
        };
    } catch (error: any) {
        console.error("Error responding to invitation:", error);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                })
            };
        }
        
        // Safely access the message property of the error object
        const errorMessage: string = (error as Error).message || "An unknown error occurred";
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};

// Exports are handled by the `export const handler` statement