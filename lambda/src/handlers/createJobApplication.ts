import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { CognitoIdentityProviderClient, AdminGetUserCommand, AttributeType } from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { fireAndForgetIncrement } from "./promotionCounters";
import { fireAndForgetJobApplicationIncrement } from "./jobPostingCounters";
import { sendNotificationEmail } from "./sendNotificationEmail";
import { renderTemplate } from "./notificationTemplates";
import {
    getProfessionalAvailability,
    getScheduledOccurrences,
    jobMatchesWeekdays,
    dateIsBlocked,
    jobTimeMatchesWindows,
    jobConflictsWithScheduled,
    jobDates,
    dateToWeekday,
} from "./professionalAvailability";
import { AttributeValue } from "@aws-sdk/client-dynamodb";

// --- 1. Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings"; 
const APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);
const cognito = new CognitoIdentityProviderClient({ region: REGION });
const USER_POOL_ID = process.env.USER_POOL_ID || "";

function pickAttr(attrs: AttributeType[] | undefined, name: string): string {
    return (attrs || []).find((x) => x.Name === name)?.Value || "";
}

async function getCognitoUser(sub: string): Promise<{ email: string; name: string } | null> {
    if (!sub || !USER_POOL_ID) return null;
    try {
        const out = await cognito.send(new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: sub,
        }));
        const email = pickAttr(out.UserAttributes, "email");
        const given = pickAttr(out.UserAttributes, "given_name");
        const family = pickAttr(out.UserAttributes, "family_name");
        const fullname = pickAttr(out.UserAttributes, "name");
        const name = [given, family].filter(Boolean).join(" ").trim()
            || fullname?.trim()
            || given?.trim()
            || "";
        return { email, name };
    } catch (err) {
        console.warn("[createJobApplication] cognito lookup failed", { sub, error: (err as Error).message });
        return null;
    }
}

async function notifyClinicOfApplication(args: {
    clinicId: string;
    clinicUserSub?: string;
    clinicProfile?: Record<string, any> | null;
    applicantSub: string;
    jobItem: Record<string, any>;
}): Promise<void> {
    try {
        let clinicEmail = (args.clinicProfile?.clinic_email || "").trim();
        if (!clinicEmail && args.clinicUserSub) {
            const u = await getCognitoUser(args.clinicUserSub);
            clinicEmail = (u?.email || "").trim();
        }
        if (!clinicEmail || !clinicEmail.includes("@")) {
            console.warn("[createJobApplication] could not resolve clinic email; skipping notification", {
                clinicId: args.clinicId,
            });
            return;
        }

        const applicant = await getCognitoUser(args.applicantSub);
        const professionalName = applicant?.name || "A professional";

        const j = args.jobItem;
        const role = j.professional_role || j.professionalRole || j.shift_speciality || j.shiftSpeciality
            || j.job_title || j.jobTitle || j.title || "";
        const rateNum = j.rate ?? (j.pay_type === "per_transaction"
            ? j.rate_per_transaction
            : j.pay_type === "percentage_of_revenue"
                ? j.revenue_percentage
                : j.hourly_rate);
        const startTime = j.startTime || j.start_time || "";
        const endTime = j.endTime || j.end_time || "";
        const date = j.date || j.startDate || j.start_date || "";

        const rendered = renderTemplate("application-received", {
            professionalName,
            clinicName: args.clinicProfile?.clinic_name || undefined,
            role: role ? String(role) : undefined,
            date: date ? String(date) : undefined,
            startTime: startTime ? String(startTime) : undefined,
            endTime: endTime ? String(endTime) : undefined,
            rate: rateNum !== undefined && rateNum !== null ? rateNum : undefined,
        });
        if (!rendered) {
            console.warn("[createJobApplication] no template rendered for application-received");
            return;
        }

        await sendNotificationEmail({
            to: clinicEmail,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
        });
    } catch (err) {
        console.error("[createJobApplication] clinic notification failed (non-fatal):", (err as Error).message);
    }
}

// --- 2. Helpers ---
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

// --- 3. Types ---
interface ApplyJobBody {
    jobId?: string; // Can be in body or path
    message?: string;
    proposedRate?: number;
    proposedSalaryMin?: number;
    proposedSalaryMax?: number;
    availability?: string;
    startDate?: string;
    notes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "POST";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // 2. Authentication (Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        console.log("User authenticated:", userSub);

        // 3. Parse Body
        if (!event.body) {
            return json(event, 400, { error: "Request body is required" });
        }
        
        let applicationData: ApplyJobBody;
        try {
            applicationData = JSON.parse(event.body);
        } catch {
            return json(event, 400, { error: "Invalid JSON in request body" });
        }

        // 4. Determine JobId (Path param takes precedence, then body)
        let jobId = event.pathParameters?.jobId;

        if (!jobId) {
            const fullPath = event.pathParameters?.proxy || event.path || ''; 
            const pathParts = fullPath.split('/').filter(Boolean);
            if (pathParts.length >= 2) {
                 jobId = pathParts[1];
            } else if (pathParts.length === 1 && pathParts[0] !== 'applications') {
                 jobId = pathParts[0];
            }
        }
        
        // Fallback to body
        if (!jobId && applicationData.jobId) {
            jobId = applicationData.jobId;
        }

        if (!jobId) {
            return json(event, 400, { error: "jobId is required (in path or body)" });
        }

        console.log("Job ID extracted:", jobId);

        // 5. Check if Job Exists (using GSI on jobId)
        const jobQuery = await ddbDoc.send(new QueryCommand({
            TableName: JOB_POSTINGS_TABLE,
            IndexName: "jobId-index-1", // Ensure this index exists in the table schema
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
                ":jobId": jobId,
            },
            Limit: 1,
        }));

        if (!jobQuery.Items || jobQuery.Items.length === 0) {
            return json(event, 404, { error: "Job posting not found" });
        }

        const jobItem = jobQuery.Items[0];
        const clinicIdFromJob = jobItem.clinicId; // Ensure `clinicId` is part of the schema

        if (!clinicIdFromJob) {
            return json(event, 400, { error: "Clinic ID not found in job posting configuration." });
        }

        const jobStatus = jobItem.status || "active";
        if (jobStatus !== "active") {
            return json(event, 409, {
                error: "Conflict",
                message: "Cannot apply to this job",
                details: { currentStatus: jobStatus, reason: "Job is not accepting applications" },
            });
        }

        // Availability gate — the Professional Profile "Availability" toggle.
        // Block applications when the pro has flipped themselves OFF: they
        // should not be able to apply (and clinics shouldn't see them as a new
        // applicant) until they flip the toggle back ON. Scheduled-job
        // visibility is handled elsewhere and stays unaffected.
        const [availability, scheduledOccurrences] = await Promise.all([
            getProfessionalAvailability(userSub),
            getScheduledOccurrences(userSub),
        ]);
        if (!availability.isAvailableForJobs) {
            return json(event, 403, {
                error: "Forbidden",
                message: "You are currently marked as unavailable for jobs.",
                details: {
                    reason: "Turn on the availability toggle in your profile to apply.",
                },
            });
        }

        // Phase 2 gates — same set the feed applies, repeated here so a pro
        // can't bypass the filter by hitting the apply endpoint directly with
        // a known jobId. jobItem here is a plain JS object (DocumentClient),
        // so we marshall it once to feed the AttributeValue-shaped helpers.
        const jobAttrItem = marshall(jobItem, {
            removeUndefinedValues: true,
        }) as Record<string, AttributeValue>;

        if (!jobMatchesWeekdays(jobAttrItem, availability.availableDays)) {
            return json(event, 409, {
                error: "Conflict",
                message: "This job doesn't match your weekly availability.",
                details: { reason: "weekday" },
            });
        }
        for (const d of jobDates(jobAttrItem)) {
            if (dateIsBlocked(d, availability.unavailableDates)) {
                return json(event, 409, {
                    error: "Conflict",
                    message: "You've marked this date as unavailable.",
                    details: { reason: "blocked_date", date: d },
                });
            }
        }
        for (const d of jobDates(jobAttrItem)) {
            const wd = dateToWeekday(d);
            if (!wd) continue;
            if (!jobTimeMatchesWindows(jobAttrItem, wd, availability.availableTimeSlots)) {
                return json(event, 409, {
                    error: "Conflict",
                    message: "This job's time doesn't fit your availability windows.",
                    details: { reason: "time_window" },
                });
            }
        }
        if (jobConflictsWithScheduled(jobAttrItem, scheduledOccurrences)) {
            return json(event, 409, {
                error: "Conflict",
                message: "This job overlaps with another shift you're already scheduled for.",
                details: { reason: "schedule_conflict" },
            });
        }

        // 6. Check for Duplicate Application
        // A "rejected" application does NOT block re-application: if the clinic
        // rejected the pro and later invited them back, the stale rejected record
        // must not stand in the way. The PutCommand below will overwrite it.
        const existingAppsResponse = await ddbDoc.send(new QueryCommand({
            TableName: APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId AND professionalUserSub = :userSub",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":userSub": userSub
            }
        }));

        const blockingApp = existingAppsResponse.Items?.find(
            (item) => String(item.applicationStatus || "").toLowerCase() !== "rejected"
        );

        if (blockingApp) {
            return json(event, 409, {
                error: "Conflict",
                message: "Duplicate application",
                details: { reason: "You have already applied to this job", jobId }
            });
        }

        // 7. Prepare Application Data
        const applicationId = uuidv4();
        const timestamp = new Date().toISOString();
        const hasProposedRate = applicationData.proposedRate !== undefined && applicationData.proposedRate !== null;
        const hasSalaryRange =
            applicationData.proposedSalaryMin !== undefined && applicationData.proposedSalaryMin !== null &&
            applicationData.proposedSalaryMax !== undefined && applicationData.proposedSalaryMax !== null;

        if (hasSalaryRange) {
            const minNum = Number(applicationData.proposedSalaryMin);
            const maxNum = Number(applicationData.proposedSalaryMax);
            if (!Number.isFinite(minNum) || !Number.isFinite(maxNum) || minNum <= 0 || maxNum <= 0) {
                return json(event, 400, { error: "Bad Request", message: "Invalid salary range values" });
            }
            if (minNum > maxNum) {
                return json(event, 400, { error: "Bad Request", message: "Minimum salary cannot exceed maximum salary" });
            }
        }

        const isNegotiating = hasProposedRate || hasSalaryRange;

        const applicationItem: Record<string, any> = {
            jobId: jobId,               // Partition Key
            professionalUserSub: userSub, // Sort Key
            applicationId: applicationId,
            clinicId: clinicIdFromJob,
            // Status logic: 'negotiating' if rate or salary range proposed, else 'pending'
            applicationStatus: isNegotiating ? "negotiating" : "pending",
            appliedAt: timestamp,
            updatedAt: timestamp,

            // Optional Fields
            applicationMessage: applicationData.message || null,
            availability: applicationData.availability || null,
            startDate: applicationData.startDate || null,
            notes: applicationData.notes || null,
            proposedRate: hasProposedRate ? Number(applicationData.proposedRate) : null,
            proposedSalaryMin: hasSalaryRange ? Number(applicationData.proposedSalaryMin) : null,
            proposedSalaryMax: hasSalaryRange ? Number(applicationData.proposedSalaryMax) : null,
            negotiationId: null
        };

        let negotiationId: string | undefined;

        // 8. Handle Negotiation Logic
        if (isNegotiating) {
            negotiationId = uuidv4();
            applicationItem.negotiationId = negotiationId;

            // Resolve the pay type from the job posting
            const jobPayType = jobItem.pay_type || jobItem.payType || "per_hour";

            const negotiationItem: Record<string, any> = {
                negotiationId: negotiationId,
                jobId: jobId,
                applicationId: applicationId,
                professionalUserSub: userSub,
                clinicId: clinicIdFromJob,
                negotiationStatus: 'pending',
                payType: jobPayType,
                createdAt: timestamp,
                updatedAt: timestamp,
                message: applicationData.message || 'Negotiation initiated by professional during application'
            };

            if (hasProposedRate) {
                negotiationItem.proposedRate = Number(applicationData.proposedRate);
            }
            if (hasSalaryRange) {
                negotiationItem.proposedSalaryMin = Number(applicationData.proposedSalaryMin);
                negotiationItem.proposedSalaryMax = Number(applicationData.proposedSalaryMax);
            }

            // Save Negotiation
            await ddbDoc.send(new PutCommand({
                TableName: JOB_NEGOTIATIONS_TABLE,
                Item: negotiationItem
            }));
            console.log("Job negotiation created");
        }

        // 9. Save Application
        await ddbDoc.send(new PutCommand({
            TableName: APPLICATIONS_TABLE,
            Item: applicationItem
        }));

        console.log("Job application saved successfully.");

        if (jobItem.isPromoted === true && jobItem.promotionId) {
            fireAndForgetIncrement(jobId, jobItem.promotionId, "applications");
        }

        // Bump the lifetime applicationsCount on the job posting (non-blocking).
        // Feeds the popularity term in computeRelevanceScore for the "Trending" sort.
        fireAndForgetJobApplicationIncrement(jobItem);

        // 10. Fetch Clinic Info (Non-fatal)
        let clinicInfo: any = null;
        let clinicProfileItem: Record<string, any> | null = null;
        try {
            // Clinic Profiles usually keyed by clinicId (and sometimes userSub).
            // Assuming PK: clinicId based on your provided snippet.
            // If your table uses composite key, you might need query or specific userSub logic here.
            const clinicRes = await ddbDoc.send(new GetCommand({
                TableName: CLINIC_PROFILES_TABLE,
                Key: { clinicId: clinicIdFromJob } // Note: Add userSub if it's part of PK in your schema
            }));

            const clinic = clinicRes.Item;
            if (clinic) {
                clinicProfileItem = clinic;
                clinicInfo = {
                    name: clinic.clinic_name || "Unknown Clinic",
                    city: clinic.city || "",
                    state: clinic.state || "",
                    practiceType: clinic.practice_type || "",
                    primaryPracticeArea: clinic.primary_practice_area || "",
                    contactName: `${clinic.primary_contact_first_name || ""} ${clinic.primary_contact_last_name || ""}`.trim()
                };
            }
        } catch (err) {
            console.warn("Failed to fetch clinic info (non-fatal):", (err as Error).message);
        }

        // 10b. Notify the clinic by email that a new applicant arrived.
        // Fire-and-forget on the same execution so it stays on the warm sandbox,
        // but wrapped so SES / Cognito failures never break the 201 response.
        notifyClinicOfApplication({
            clinicId: clinicIdFromJob,
            clinicUserSub: jobItem.clinicUserSub || jobItem.clinic_user_sub,
            clinicProfile: clinicProfileItem,
            applicantSub: userSub,
            jobItem,
        }).catch((err) => {
            console.error("[createJobApplication] unhandled notify error:", (err as Error).message);
        });

        // 11. Construct Response
        const jobInfo = {
            title: jobItem.job_title || `${jobItem.professional_role || 'Professional'} Position`,
            type: jobItem.job_type || 'unknown',
            role: jobItem.professional_role || '',
            rate: jobItem.rate ?? (jobItem.pay_type === "per_transaction" ? jobItem.rate_per_transaction : jobItem.pay_type === "percentage_of_revenue" ? jobItem.revenue_percentage : jobItem.hourly_rate) ?? 0,
            payType: jobItem.pay_type || "per_hour",
            date: jobItem.date,
            dates: jobItem.dates
        };

        return json(event, 201, {
            status: "success",
            statusCode: 201,
            message: "Job application submitted successfully",
            data: {
                applicationId,
                jobId,
                applicationStatus: isNegotiating ? "negotiating" : "pending",
                appliedAt: timestamp,
                job: jobInfo,
                clinic: clinicInfo
            },
            timestamp: timestamp
        });

    } catch (err) {
        const error = err as Error;
        console.error("Error creating job application:", error);
        return json(event, 500, { 
            error: "Internal Server Error", 
            message: "Failed to submit job application",
            details: error.message 
        });
    }
};