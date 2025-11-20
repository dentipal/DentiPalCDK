import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    AttributeValue,
    QueryCommandOutput,
    ScanCommandOutput,
    ScanCommandInput,
    QueryCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Simplified type for a raw DynamoDB item
interface DynamoDBJobItem {
    jobId?: AttributeValue;
    job_type?: AttributeValue;
    clinicUserSub?: AttributeValue;
    // Fields used in mapping
    job_title?: AttributeValue;
    professional_role?: AttributeValue;
    job_description?: AttributeValue;
    requirements?: AttributeValue;
    working_days?: AttributeValue;
    start_time?: AttributeValue;
    end_time?: AttributeValue;
    clinicSoftware?: AttributeValue;
    hours_per_week?: AttributeValue;
    work_schedule?: AttributeValue;
    start_date?: AttributeValue;
    shift_speciality?: AttributeValue;
    freeParkingAvailable?: AttributeValue;
    parkingType?: AttributeValue;
    parking_rate?: AttributeValue;
    salary_min?: AttributeValue;
    salary_max?: AttributeValue;
    bonus_structure?: AttributeValue;
    benefits?: AttributeValue;
    addressLine1?: AttributeValue;
    addressLine2?: AttributeValue;
    addressLine3?: AttributeValue;
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    contact_email?: AttributeValue;
    contact_phone?: AttributeValue;
    special_requirements?: AttributeValue;
    equipment_provided?: AttributeValue;
    parking_info?: AttributeValue;
    career_path?: AttributeValue;
    mentorship_available?: AttributeValue;
    continuing_education_support?: AttributeValue;
    relocation_assistance?: AttributeValue;
    visa_sponsorship?: AttributeValue;
    status?: AttributeValue;
    created_at?: AttributeValue;
    updated_at?: AttributeValue;
    clinicId?: AttributeValue;
    // ... all other fields
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped job object
interface JobResponseItem {
    jobId: string;
    jobType: string;
    clinicUserSub: string;
    clinicId: string;
    professionalRole: string;
    jobTitle: string;
    description: string;
    requirements: string[];
    payType: string;
    startDate: string;
    shiftSpeciality: string;
    SoftwareRequired: string;
    schedule: {
        workingDays: string[];
        startTime: string;
        endTime: string;
        hoursPerWeek: number;
    };
    freeParkingAvailable: boolean;
    parkingType: string;
    parkingRate: number;
    compensation: {
        salaryRange: {
            min: number;
            max: number;
        };
        bonusStructure: string;
        benefits: string[];
    };
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
    equipmentProvided: string[];
    parkingInfo: string;
    careerPath: string;
    mentorshipAvailable: boolean;
    continuingEducationSupport: boolean;
    relocationAssistance: boolean;
    visaSponsorship: boolean;
    status: string;
    createdAt: string;
    updatedAt: string;
    applicationCount: number;
    applicationsEnabled: boolean;
}

// --- helper: get all jobIds this professional has applied to ---

/**
 * Queries DynamoDB to get a Set of job IDs the given professional has applied to.
 * Uses a GSI for efficient querying.
 * @param userSub The professional's user sub (Partition Key on the GSI).
 * @returns A Set of applied job IDs (strings).
 */
async function getAppliedJobIdsForUser(userSub: string): Promise<Set<string>> {
    const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
    const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

    const ids = new Set<string>();
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
        const queryInput: QueryCommandInput = {
            TableName: table,
            IndexName: index,
            KeyConditionExpression: "professionalUserSub = :sub",
            ProjectionExpression: "jobId",
            ExpressionAttributeValues: { ":sub": { S: userSub } },
            ExclusiveStartKey,
        };
        
        const resp: QueryCommandOutput = await dynamodb.send(new QueryCommand(queryInput));
        
        // Extract jobId strings from items
        (resp.Items || []).forEach(it => it.jobId?.S && ids.add(it.jobId.S!));
        
        ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    return ids;
}

// --- helper: normalize DynamoDB attribute to string array ---

/**
 * Normalizes a DynamoDB AttributeValue (SS, L, or S) into a string array.
 * @param attr The DynamoDB AttributeValue object.
 * @returns An array of strings.
 */
function toStrArr(attr: AttributeValue | undefined): string[] {
    if (!attr) return [];
    
    // String Set (SS)
    if (Array.isArray(attr.SS)) return attr.SS as string[];
    
    // List (L) of {S: "..."}
    if (Array.isArray(attr.L)) {
        return attr.L.map(v => (v && typeof v.S === "string" ? v.S : null))
            .filter((s): s is string => !!s);
    }
    
    // Single String (S)
    if (typeof attr.S === "string") return [attr.S];
    
    return [];
}


// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Validate token and get the actual user sub
        const userSub: string = await validateToken(event as any);

        // 2. Scan permanent jobs only
        // NOTE: Scanning is inefficient. Consider a GSI if the table size grows.
        const scanInput: ScanCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            FilterExpression: "job_type = :jobType",
            ExpressionAttributeValues: {
                ":jobType": { S: "permanent" }
            }
        };
        
        const jobsCommand = new ScanCommand(scanInput);
        const jobResponse: ScanCommandOutput = await dynamodb.send(jobsCommand);
        const items: DynamoDBJobItem[] = (jobResponse.Items as DynamoDBJobItem[] || []);

        // 3. Exclude jobs the pro already applied to
        const appliedJobIds = await getAppliedJobIdsForUser(userSub);
        
        // Only check for applied jobs if jobId is present.
        const visibleItems = items.filter(it => {
            const jobId = it.jobId?.S;
            return jobId ? !appliedJobIds.has(jobId) : true;
        });

        // 4. Map visible items to your response shape
        const jobs: JobResponseItem[] = visibleItems.map(job => {
            // Helper to safely parse numbers
            const parseNum = (attr: AttributeValue | undefined): number => 
                attr?.N ? parseFloat(attr.N) : 0;
            
            // Helper to safely get string array (SS)
            const getSS = (attr: AttributeValue | undefined): string[] => 
                toStrArr(attr);

            // Helper to safely get boolean (BOOL)
            const getBool = (attr: AttributeValue | undefined): boolean => 
                attr?.BOOL || false;

            const jobStatus = job.status?.S || 'active';

            return {
                jobId: job.jobId?.S || '',
                jobType: job.job_type?.S || '',
                clinicUserSub: job.clinicUserSub?.S || '',
                clinicId: job.clinicId?.S || '',
                professionalRole: job.professional_role?.S || '',
                jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Permanent Position`,
                description: job.job_description?.S || '',
                requirements: getSS(job.requirements),
                payType: job.work_schedule?.S || '',
                startDate: job.start_date?.S || '',
                shiftSpeciality: job.shift_speciality?.S || "",
                SoftwareRequired: job.clinicSoftware?.S || "",
                schedule: {
                    workingDays: getSS(job.working_days),
                    startTime: job.start_time?.S || '',
                    endTime: job.end_time?.S || '',
                    hoursPerWeek: parseNum(job.hours_per_week)
                },
                freeParkingAvailable: getBool(job.freeParkingAvailable),
                parkingType: job.parkingType?.S || '',
                parkingRate: parseNum(job.parking_rate),
                compensation: {
                    salaryRange: {
                        min: parseNum(job.salary_min),
                        max: parseNum(job.salary_max)
                    },
                    bonusStructure: job.bonus_structure?.S || '',
                    benefits: getSS(job.benefits)
                },
                location: {
                    addressLine1: job.addressLine1?.S || '',
                    addressLine2: job.addressLine2?.S || '',
                    addressLine3: job.addressLine3?.S || '',
                    city: job.city?.S || '',
                    state: job.state?.S || '',
                    zipCode: job.pincode?.S || ''
                },
                contactInfo: {
                    email: job.contact_email?.S || '',
                    phone: job.contact_phone?.S || ''
                },
                specialRequirements: getSS(job.special_requirements),
                equipmentProvided: getSS(job.equipment_provided),
                parkingInfo: job.parking_info?.S || '',
                careerPath: job.career_path?.S || '',
                mentorshipAvailable: getBool(job.mentorship_available),
                continuingEducationSupport: getBool(job.continuing_education_support),
                relocationAssistance: getBool(job.relocation_assistance),
                visaSponsorship: getBool(job.visa_sponsorship),
                status: jobStatus,
                createdAt: job.created_at?.S || '',
                updatedAt: job.updated_at?.S || '',
                applicationCount: 0, // Hardcoded as 0, matching the original logic
                applicationsEnabled: jobStatus === 'active'
            };
        });

        // 5. Success Response
        return json(200, {
            message: "Permanent jobs retrieved successfully",
            excludedCount: appliedJobIds.size, 
            jobs
        });

    } catch (error: any) {
        console.error("Error retrieving permanent jobs:", error);
        return json(500, {
            error: "Failed to retrieve permanent jobs. Please try again.",
            details: error?.message || String(error)
        });
    }
};