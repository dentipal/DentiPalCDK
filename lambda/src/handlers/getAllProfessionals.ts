import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    AttributeValue,
    ScanCommandOutput,
    QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Changed import to use the new token utility
import { extractUserFromBearerToken } from "./utils";

import { corsHeaders } from "./corsHeaders";
import {
    readAvailabilityFromProfileItem,
    getScheduledOccurrences,
    jobMatchesWeekdays,
    jobDates,
    dateIsBlocked,
    jobConflictsWithScheduled,
} from "./professionalAvailability";

// Initialize DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Build a synthetic job-shaped DynamoDB item from query-string fields so the
// existing `jobBlockedByAvailability` helper can score each pro without
// needing a saved job posting. Used when the modal is opened during a
// not-yet-saved job-post flow (`PostTemporaryJob` / `MultiDayConsultingJob`).
function buildSyntheticJob(opts: {
    date?: string;
    dates?: string[];
    startTime?: string;
    endTime?: string;
}): Record<string, AttributeValue> {
    const job: Record<string, AttributeValue> = {};
    if (opts.date) job.date = { S: opts.date };
    if (opts.dates && opts.dates.length > 0) job.dates = { SS: opts.dates };
    if (opts.startTime) job.start_time = { S: opts.startTime };
    if (opts.endTime) job.end_time = { S: opts.endTime };
    return job;
}

// Fetch a saved job posting by jobId via the same GSI used by
// sendJobInvitations (`jobId-index-1` on JOB_POSTINGS_TABLE). Returns the raw
// item so the availability helpers can read its date / time attributes
// directly. Null when the jobId is unknown or the table env is missing —
// caller falls back to "no filter".
async function fetchJobItem(jobId: string): Promise<Record<string, AttributeValue> | null> {
    const TABLE = process.env.JOB_POSTINGS_TABLE;
    if (!TABLE) return null;
    try {
        const resp = await dynamodb.send(new QueryCommand({
            TableName: TABLE,
            IndexName: process.env.JOB_ID_INDEX || "jobId-index-1",
            KeyConditionExpression: "jobId = :jid",
            ExpressionAttributeValues: { ":jid": { S: jobId } },
            Limit: 1,
        }));
        return (resp.Items?.[0] as Record<string, AttributeValue>) || null;
    } catch (err) {
        console.warn(`[getAllProfessionals] job lookup failed for ${jobId}:`, (err as Error).message);
        return null;
    }
}

// --- Type Definitions ---

// Simplified type for a raw DynamoDB profile item
interface DynamoDBProfileItem {
    userSub?: AttributeValue;
    dental_software_experience?: AttributeValue; // SS
    first_name?: AttributeValue;
    full_name?: AttributeValue;
    last_name?: AttributeValue;
    role?: AttributeValue;
    specialties?: AttributeValue; // SS
    // The create/update handlers persist this attribute as `yearsExperience`
    // (camelCase, mirroring the frontend payload key). Older rows may carry
    // the snake_case `years_of_experience` form. Read whichever is present.
    yearsExperience?: AttributeValue;       // N — current
    years_of_experience?: AttributeValue;   // N — legacy
    yearsOfExperience?: AttributeValue;     // N — alt legacy
    [key: string]: AttributeValue | undefined;
}

// Simplified type for a raw DynamoDB address item
interface DynamoDBAddressItem {
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    lat?: AttributeValue; // N — geocoded latitude (optional, present once address is geocoded)
    lng?: AttributeValue; // N — geocoded longitude
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped profile object
interface ProfileResponseItem {
    userSub: string;
    dentalSoftwareExperience: string[];
    firstName: string;
    fullName: string;
    lastName: string;
    role: string;
    specialties: string[];
    yearsOfExperience: number;
    city: string;
    state: string;
    zipcode: string;
    lat: number | null;
    lng: number | null;
    // Denormalized rating aggregates stored on the profile row by
    // submitProfessionalRating. Null/0 when the pro has no ratings yet.
    avgRating: number | null;
    ratingCount: number;
}

// Helper: parse a DynamoDB N attribute as a finite number, else null
const parseNumOrNull = (attr?: AttributeValue): number | null => {
    if (!attr || !("N" in attr) || typeof attr.N !== "string") return null;
    const v = parseFloat(attr.N);
    return Number.isFinite(v) ? v : null;
};

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        // Validate token but ignore result if userSub is not used for filtering
        extractUserFromBearerToken(authHeader);

        // 2. Scan professional profiles table
        const scanCommand = new ScanCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
        });

        const result: ScanCommandOutput = await dynamodb.send(scanCommand);
        const rawProfiles: DynamoDBProfileItem[] = (result.Items as DynamoDBProfileItem[] || []);

        // Hide pros who toggled themselves OFF in their Availability section
        // from the clinic-side discovery list. Legacy rows (no attribute) stay
        // visible by virtue of readAvailabilityFromProfileItem's default.
        let visibleProfiles = rawProfiles.filter((item) => {
            const { isAvailableForJobs } = readAvailabilityFromProfileItem(
                item as unknown as Record<string, AttributeValue>,
            );
            return isAvailableForJobs;
        });

        // ----- Optional Phase-2 filter: job-specific availability -----
        // When the modal is opened in a job context, the client passes the
        // job's identity (jobId for saved jobs) or its date/time (for the
        // not-yet-saved post-job flow) as query params. We re-use the
        // `jobBlockedByAvailability` gate that `sendJobInvitations` enforces
        // at submit time, so a pro who'd be rejected at invite time is
        // simply not shown here. Purely additive: when no params are
        // supplied, the list is unchanged.
        const qs = event.queryStringParameters || {};
        const jobIdParam = qs.jobId?.trim() || "";
        const dateParam = qs.date?.trim() || "";
        const datesParam = qs.dates?.trim() || ""; // CSV
        const startTimeParam = qs.startTime?.trim() || "";
        const endTimeParam = qs.endTime?.trim() || "";

        const hasInlineSlot =
            !!dateParam || !!datesParam || !!startTimeParam || !!endTimeParam;
        const hasJobContext = !!jobIdParam || hasInlineSlot;

        if (hasJobContext) {
            // Resolve the candidate job: either a saved posting (jobId) or
            // a synthetic one built from inline date/time fields.
            let jobItem: Record<string, AttributeValue> | null = null;
            if (jobIdParam) {
                jobItem = await fetchJobItem(jobIdParam);
            }
            if (!jobItem && hasInlineSlot) {
                jobItem = buildSyntheticJob({
                    date: dateParam || undefined,
                    dates: datesParam
                        ? datesParam.split(",").map((d) => d.trim()).filter(Boolean)
                        : undefined,
                    startTime: startTimeParam || undefined,
                    endTime: endTimeParam || undefined,
                });
            }

            // Only run the gate when we actually have a job shape to match
            // against — otherwise we'd silently drop everyone.
            if (jobItem && Object.keys(jobItem).length > 0) {
                const scored = await Promise.all(visibleProfiles.map(async (item) => {
                    const sub = item.userSub?.S || "";
                    if (!sub) return { item, keep: true };
                    const availability = readAvailabilityFromProfileItem(
                        item as unknown as Record<string, AttributeValue>,
                    );

                    // Day-only filter (intentionally NOT calling the shared
                    // `jobBlockedByAvailability` because it also enforces
                    // per-day time windows, which we don't want here — the
                    // clinic only needs to know the pro covers the day):
                    //   1. Master toggle on (already enforced above, but keep
                    //      defensive in case the upstream filter changes).
                    //   2. Weekday is in the pro's available_days.
                    //   3. None of the job's dates are in unavailable_dates.
                    //   4. The pro isn't already scheduled for another clinic
                    //      on the same date (schedule conflict).
                    if (!availability.isAvailableForJobs) return { item, keep: false };
                    if (!jobMatchesWeekdays(jobItem!, availability.availableDays)) {
                        return { item, keep: false };
                    }
                    for (const d of jobDates(jobItem!)) {
                        if (dateIsBlocked(d, availability.unavailableDates)) {
                            return { item, keep: false };
                        }
                    }
                    const scheduled = await getScheduledOccurrences(sub);
                    if (jobConflictsWithScheduled(jobItem!, scheduled)) {
                        return { item, keep: false };
                    }
                    return { item, keep: true };
                }));
                visibleProfiles = scored.filter((s) => s.keep).map((s) => s.item);
            }
        }

        // 3. Process the result and fetch addresses concurrently
        const profiles: ProfileResponseItem[] = await Promise.all(visibleProfiles.map(async (item) => {
            const currentSub = item.userSub?.S || '';

            // Fetch user address details (city, state, pincode) from USER_ADDRESSES_TABLE
            const addressCommand = new QueryCommand({
                TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
                KeyConditionExpression: "userSub = :userSub",
                ExpressionAttributeValues: {
                    ":userSub": { S: currentSub }
                }
            });

            const addressResult: QueryCommandOutput = await dynamodb.send(addressCommand);
            const address: DynamoDBAddressItem = (addressResult.Items?.[0] as DynamoDBAddressItem) || {};
            
            const city = address.city?.S || '';
            const state = address.state?.S || '';
            const zipcode = address.pincode?.S || '';
            const lat = parseNumOrNull(address.lat);
            const lng = parseNumOrNull(address.lng);

            // Extract and transform profile fields
            const dentalSoftwareExperience: string[] = item.dental_software_experience?.SS || [];
            const specialties: string[] = item.specialties?.SS || [];

            // Years of experience: the writer stores `yearsExperience` (camelCase)
            // — mirroring the frontend payload key — so prefer that. Fall back
            // through the legacy snake_case and alt camelCase variants for rows
            // written by older code paths. Without these fallbacks every profile
            // reads as 0 and the Find Professionals card shows "Not specified".
            const yearsRaw =
                item.yearsExperience?.N ??
                item.years_of_experience?.N ??
                item.yearsOfExperience?.N;
            const yearsParsed = yearsRaw ? parseFloat(yearsRaw) : NaN;
            const yearsOfExperience: number = Number.isFinite(yearsParsed) ? yearsParsed : 0;

            // Denormalized rating aggregates written by submitProfessionalRating.
            // Read straight off the profile row — same source of truth used by
            // the applicant list and YourRatingBanner.
            const avgRating = parseNumOrNull(item.avgRating);
            const ratingCountRaw = parseNumOrNull(item.ratingCount);
            const ratingCount = ratingCountRaw != null ? Math.trunc(ratingCountRaw) : 0;

            // Return the structured profile
            return {
                userSub: currentSub,
                dentalSoftwareExperience: dentalSoftwareExperience,
                firstName: item.first_name?.S || '',
                fullName: item.full_name?.S || '',
                lastName: item.last_name?.S || '',
                role: item.role?.S || '',
                specialties: specialties,
                yearsOfExperience: yearsOfExperience,
                city: city,
                state: state,
                zipcode: zipcode,
                lat,
                lng,
                avgRating,
                ratingCount
            };
        }));

        // 4. Return the successful response
        return json(event, 200, {
            status: "success",
            statusCode: 200,
            message: "Professional profiles retrieved successfully",
            data: {
                profiles: profiles,
                count: profiles.length
            },
            timestamp: new Date().toISOString()
        });
    } catch (error: any) {
        console.error("Error fetching professional profiles:", error);

        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return json(event, 401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to retrieve professional profiles",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};