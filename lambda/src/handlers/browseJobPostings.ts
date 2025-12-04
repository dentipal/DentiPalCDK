import {
    DynamoDBClient,
    ScanCommand,
    GetItemCommand,
    ScanCommandInput,
    GetItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming extractUserFromBearerToken exists in a local utility file
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Interfaces ---

// Define the structure for the job object that will be returned
interface JobPosting {
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
    hourlyRate: number;
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
    clinic?: { // Optional clinic details
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

// --- Handler ---

// Define the Lambda handler function
// Define the Lambda handler function
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // --- CORS preflight ---
        // FIX: Cast event to 'any' to access .http (HTTP API v2) property without TS error
        const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

        if (method === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // Step 1: Authenticate user - Extract access token
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, {
                error: authError.message || "Invalid access token"
            });
        }
        
        // ... rest of your code remains the same ...
        const queryParams = event.queryStringParameters || {};

        // Step 2: Extract and type query parameters
        const jobType: string | undefined = queryParams.jobType; // temporary, multi_day_consulting, permanent
        const professionalRole: string | undefined = queryParams.role; // dentist, hygienist, assistant
        const shiftSpeciality: string | undefined = queryParams.speciality; // general_dentistry, oral_surgeon, etc.
        const minRate: number | undefined = queryParams.minRate ? parseFloat(queryParams.minRate) : undefined;
        const maxRate: number | undefined = queryParams.maxRate ? parseFloat(queryParams.maxRate) : undefined;
        const dateFrom: string | undefined = queryParams.dateFrom; // ISO date string
        const dateTo: string | undefined = queryParams.dateTo; // ISO date string
        const assistedHygiene: boolean = queryParams.assistedHygiene === 'true';
        const limit: number = queryParams.limit ? parseInt(queryParams.limit) : 50;

        // Validate professional role if provided
        const VALID_ROLES = ['dentist', 'hygienist', 'assistant'];
        if (professionalRole && !VALID_ROLES.includes(professionalRole)) {
            return json(400, {
                error: `Invalid professional role. Valid options: ${VALID_ROLES.join(', ')}`
            });
        }

        // Step 3: Build filter expression for DynamoDB Scan
        const filterExpressions: string[] = [];
        const expressionAttributeValues: Record<string, AttributeValue> = {};
        const expressionAttributeNames: Record<string, string> = {};

        // Always filter by status = 'active'
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
            Limit: limit * 2
        };

        const scanCommand = new ScanCommand(scanCommandInput);
        const scanResponse = await dynamodb.send(scanCommand);
        const jobPostings: JobPosting[] = [];

        if (scanResponse.Items) {
            for (const item of scanResponse.Items) {
                // Map DynamoDB item to JobPosting interface structure
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
                    hourlyRate: item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : 0,
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
                    location: {
                        addressLine1: item.addressLine1?.S || '',
                        addressLine2: item.addressLine2?.S || '',
                        addressLine3: item.addressLine3?.S || '',
                        city: item.city?.S || '',
                        state: item.state?.S || '',
                        zipCode: item.pincode?.S || ''
                    },
                    contactInfo: {
                        email: item.contact_email?.S || '',
                        phone: item.contact_phone?.S || ''
                    },
                    specialRequirements: item.special_requirements?.SS || [],
                    projectScope: item.project_scope?.S || '',
                    consultingType: item.consulting_type?.S || '',
                    expectedOutcome: item.expected_outcome?.S || '',
                };

                // Step 4: Fetch clinic details for location
                try {
                    const clinicCommandInput: GetItemCommandInput = {
                        TableName: process.env.CLINIC_PROFILES_TABLE,
                        Key: {
                            userSub: { S: job.clinicUserSub }
                        }
                    };
                    const clinicCommand = new GetItemCommand(clinicCommandInput);
                    const clinicResponse = await dynamodb.send(clinicCommand);
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
                    // Continue without clinic details
                }

                jobPostings.push(job);

                // Stop if we have enough results (client side limit logic)
                if (jobPostings.length >= limit) break;
            }
        }

        // Sort by posted date (most recent first)
        jobPostings.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

        // Step 5: Return results
        return json(200, {
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
                limit
            }
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error browsing job postings:", err);
        return json(500, {
            error: "Failed to retrieve job postings. Please try again.",
            details: err.message
        });
    }
};

exports.handler = handler;