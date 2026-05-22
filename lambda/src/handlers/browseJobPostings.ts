import {
    DynamoDBClient,
    ScanCommand,
    GetItemCommand,
    ScanCommandInput,
    GetItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractAuthFromEvent, AuthContext } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { VALID_ROLE_VALUES } from "./professionalRoles";

const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// --- Types ---

export interface BrowseJobPostingsInput {
    jobType?: string;
    professionalRole?: string;
    shiftSpeciality?: string;
    minRate?: number;
    maxRate?: number;
    dateFrom?: string;
    dateTo?: string;
    assistedHygiene?: boolean;
    limit?: number;
}

export interface JobPosting {
    jobId: string;
    clinicUserSub: string;
    clinicId: string;
    jobType: string;
    professionalRole: string;
    shiftSpeciality: string;
    assistedHygiene: boolean;
    status: string;
    SoftwareRequired: string;
    postedAt: string;
    updatedAt: string;
    jobTitle: string;
    jobDescription: string;
    rate: number;
    payType: string;
    salaryMin: number;
    salaryMax: number;
    date: string;
    dates: string[];
    hours: number;
    hoursPerDay: number;
    totalDays: number;
    employmentType: string;
    benefits: string[];
    requirements: string[];
    mealBreak: boolean;
    parkingType: string;
    parkingRate: number;
    lat?: number;
    lng?: number;
    location: {
        addressLine1: string;
        addressLine2: string;
        addressLine3: string;
        city: string;
        state: string;
        zipCode: string;
    };
    contactInfo: {
        email: string;
        phone: string;
    };
    specialRequirements: string[];
    projectScope: string;
    consultingType: string;
    expectedOutcome: string;
    clinic?: {
        name: string;
        city: string;
        state: string;
        practiceType: string;
        primaryPracticeArea: string;
        contactName: string;
        freeParkingAvailable: boolean;
        assistedHygieneAvailable: boolean;
    };
}

export interface BrowseJobPostingsResult {
    status: number;
    body: any;
}

// --- Core logic ---

export async function runBrowseJobPostings(
    input: BrowseJobPostingsInput,
    _auth: AuthContext
): Promise<BrowseJobPostingsResult> {
    const {
        jobType,
        professionalRole,
        shiftSpeciality,
        minRate,
        maxRate,
        dateFrom,
        dateTo,
        assistedHygiene = false,
        limit = 50,
    } = input;

    if (professionalRole && !VALID_ROLE_VALUES.includes(professionalRole)) {
        return {
            status: 400,
            body: { error: `Invalid professional role. Valid options: ${VALID_ROLE_VALUES.join(', ')}` },
        };
    }

    const filterExpressions: string[] = [];
    const expressionAttributeValues: Record<string, AttributeValue> = {};
    const expressionAttributeNames: Record<string, string> = {};

    filterExpressions.push("#status = :active");
    expressionAttributeValues[":active"] = { S: "active" };
    expressionAttributeNames["#status"] = "status";

    if (jobType) {
        filterExpressions.push("job_type = :jobType");
        expressionAttributeValues[":jobType"] = { S: jobType };
    }
    if (professionalRole) {
        filterExpressions.push("professional_role = :role");
        expressionAttributeValues[":role"] = { S: professionalRole };
    }
    if (shiftSpeciality) {
        filterExpressions.push("shift_speciality = :speciality");
        expressionAttributeValues[":speciality"] = { S: shiftSpeciality };
    }
    if (assistedHygiene) {
        filterExpressions.push("assisted_hygiene = :assistedHygiene");
        expressionAttributeValues[":assistedHygiene"] = { BOOL: assistedHygiene };
    }

    const scanCommandInput: ScanCommandInput = {
        TableName: process.env.JOB_POSTINGS_TABLE,
        FilterExpression: filterExpressions.join(" AND "),
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: limit * 2,
    };

    const scanResponse = await dynamodb.send(new ScanCommand(scanCommandInput));
    const jobPostings: JobPosting[] = [];

    if (scanResponse.Items) {
        for (const item of scanResponse.Items) {
            const job: JobPosting = {
                jobId: item.jobId?.S || '',
                clinicUserSub: item.clinicUserSub?.S || '',
                clinicId: item.clinicId?.S || '',
                jobType: item.job_type?.S || '',
                professionalRole: item.professional_role?.S || '',
                shiftSpeciality: item.shift_speciality?.S || '',
                assistedHygiene: item.assisted_hygiene?.BOOL || false,
                status: item.status?.S || 'active',
                SoftwareRequired: item.clinicSoftware?.S || "",
                postedAt: item.createdAt?.S || '',
                updatedAt: item.updatedAt?.S || '',
                jobTitle: item.job_title?.S || '',
                jobDescription: item.job_description?.S || '',
                rate: item.rate?.N
                    ? parseFloat(item.rate.N)
                    : (item.pay_type?.S === "per_transaction"
                        ? (item.rate_per_transaction?.N ? parseFloat(item.rate_per_transaction.N) : 0)
                        : item.pay_type?.S === "percentage_of_revenue"
                            ? (item.revenue_percentage?.N ? parseFloat(item.revenue_percentage.N) : 0)
                            : (item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : 0)),
                payType: item.pay_type?.S || "per_hour",
                salaryMin: item.salary_min?.N ? parseFloat(item.salary_min.N) : 0,
                salaryMax: item.salary_max?.N ? parseFloat(item.salary_max.N) : 0,
                date: item.date?.S || '',
                dates: item.dates?.SS || [],
                hours: item.hours?.N ? parseFloat(item.hours.N) : 0,
                hoursPerDay: item.hours_per_day?.N ? parseFloat(item.hours_per_day.N) : 0,
                totalDays: item.total_days?.N ? parseFloat(item.total_days.N) : 0,
                employmentType: item.employment_type?.S || '',
                benefits: item.benefits?.SS || [],
                requirements: item.requirements?.SS || [],
                mealBreak: item.meal_break?.BOOL || false,
                parkingType: item.parkingType?.S || '',
                parkingRate: item.parking_rate?.N ? parseFloat(item.parking_rate.N) : 0,
                lat: item.lat?.N ? parseFloat(item.lat.N) : undefined,
                lng: item.lng?.N ? parseFloat(item.lng.N) : undefined,
                location: {
                    addressLine1: item.addressLine1?.S || '',
                    addressLine2: item.addressLine2?.S || '',
                    addressLine3: item.addressLine3?.S || '',
                    city: item.city?.S || '',
                    state: item.state?.S || '',
                    zipCode: item.pincode?.S || '',
                },
                contactInfo: {
                    email: item.contact_email?.S || '',
                    phone: item.contact_phone?.S || '',
                },
                specialRequirements: item.special_requirements?.SS || [],
                projectScope: item.project_scope?.S || '',
                consultingType: item.consulting_type?.S || '',
                expectedOutcome: item.expected_outcome?.S || '',
            };

            // Skip jobs whose owning clinic is soft-deleted. The cascade
            // Lambda flips a soft-deleted clinic's jobs to status =
            // "clinic_deleted", but if any path here ever reaches an active
            // row for a soft-deleted clinic, this guard prevents leaking
            // the clinic name + contact details to professionals.
            if (job.clinicId && process.env.CLINICS_TABLE) {
                try {
                    const clinicCheck = await dynamodb.send(new GetItemCommand({
                        TableName: process.env.CLINICS_TABLE,
                        Key: { clinicId: { S: job.clinicId } },
                        ProjectionExpression: "deletedAt",
                    }));
                    if (!clinicCheck.Item || clinicCheck.Item.deletedAt?.S) {
                        continue; // skip this job entirely
                    }
                } catch (err) {
                    console.warn(`[browseJobPostings] deletedAt check failed for clinic ${job.clinicId}:`, (err as Error).message);
                    // Conservative: keep the job rather than hide live data on a transient error.
                }
            }

            try {
                const clinicCommandInput: GetItemCommandInput = {
                    TableName: process.env.CLINIC_PROFILES_TABLE,
                    Key: { userSub: { S: job.clinicUserSub } },
                };
                const clinicResponse = await dynamodb.send(new GetItemCommand(clinicCommandInput));
                if (clinicResponse.Item) {
                    const clinic = clinicResponse.Item;
                    job.clinic = {
                        name: clinic.clinic_name?.S || 'Unknown Clinic',
                        city: clinic.city?.S || '',
                        state: clinic.state?.S || '',
                        practiceType: clinic.practice_type?.S || '',
                        primaryPracticeArea: clinic.primary_practice_area?.S || '',
                        contactName: `${clinic.primary_contact_first_name?.S || ''} ${clinic.primary_contact_last_name?.S || ''}`.trim() || 'Contact',
                        freeParkingAvailable: clinic.free_parking_available?.BOOL || false,
                        assistedHygieneAvailable: clinic.assisted_hygiene_available?.BOOL || false,
                    };
                }
            } catch (clinicError) {
                console.warn(`Failed to fetch clinic details for ${job.clinicUserSub}:`, (clinicError as Error).message);
            }

            jobPostings.push(job);
            if (jobPostings.length >= limit) break;
        }
    }

    jobPostings.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

    return {
        status: 200,
        body: {
            message: "Job postings retrieved successfully",
            jobPostings,
            totalCount: jobPostings.length,
            filters: {
                jobType: jobType || 'all',
                professionalRole: professionalRole || 'all',
                shiftSpeciality: shiftSpeciality || 'all',
                minRate,
                maxRate,
                dateFrom,
                dateTo,
                assistedHygiene: assistedHygiene || false,
                limit,
            },
        },
    };
}

// --- Thin API Gateway adapter ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";
        if (method === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders(event), body: "" };
        }

        let auth: AuthContext;
        try {
            auth = extractAuthFromEvent(event);
        } catch (authError: any) {
            return json(event, 401, { error: authError.message || "Invalid access token" });
        }

        const q = event.queryStringParameters || {};
        const input: BrowseJobPostingsInput = {
            jobType: q.jobType,
            professionalRole: q.role,
            shiftSpeciality: q.speciality,
            minRate: q.minRate ? parseFloat(q.minRate) : undefined,
            maxRate: q.maxRate ? parseFloat(q.maxRate) : undefined,
            dateFrom: q.dateFrom,
            dateTo: q.dateTo,
            assistedHygiene: q.assistedHygiene === 'true',
            limit: q.limit ? parseInt(q.limit) : 50,
        };

        const { status, body } = await runBrowseJobPostings(input, auth);
        return json(event, status, body);

    } catch (error) {
        const err = error as Error;
        console.error("Error browsing job postings:", err);
        return json(event, 500, { error: "Failed to retrieve job postings. Please try again.", details: err.message });
    }
};

exports.handler = handler;
