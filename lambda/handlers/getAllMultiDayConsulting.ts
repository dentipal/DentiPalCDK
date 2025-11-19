// index.ts
import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    AttributeValue,
    QueryCommandOutput,
    ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken } from "./utils"; 

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

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
    dates?: AttributeValue;
    start_time?: AttributeValue;
    end_time?: AttributeValue;
    clinicSoftware?: AttributeValue;
    hourly_rate?: AttributeValue;
    meal_break?: AttributeValue;
    shift_speciality?: AttributeValue;
    freeParkingAvailable?: AttributeValue;
    parkingType?: AttributeValue;
    parking_rate?: AttributeValue;
    addressLine1?: AttributeValue;
    addressLine2?: AttributeValue;
    addressLine3?: AttributeValue;
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    contact_email?: AttributeValue;
    contact_phone?: AttributeValue;
    special_requirements?: AttributeValue;
    project_scope?: AttributeValue;
    consulting_type?: AttributeValue;
    expected_outcome?: AttributeValue;
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
    dates: string[];
    startTime: string;
    endTime: string;
    SoftwareRequired: string;
    hourlyRate: number;
    totalDays: number;
    mealBreak: string | boolean | null;
    shiftSpeciality: string;
    freeParkingAvailable: boolean;
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
    status: string;
    createdAt: string;
    updatedAt: string;
}

// --- helper: get all jobIds this professional has applied to ---

/**
 * Queries DynamoDB to get a Set of job IDs the given professional has applied to.
 * @param userSub The professional's user sub (Partition Key on the GSI).
 * @returns A Set of applied job IDs (strings).
 */
async function getAppliedJobIdsForUser(userSub: string): Promise<Set<string>> {
    const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
    const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

    const ids = new Set<string>();
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

    do {
        const resp: QueryCommandOutput = await dynamodb.send(new QueryCommand({
            TableName: table,
            IndexName: index,
            KeyConditionExpression: "professionalUserSub = :sub",
            ProjectionExpression: "jobId",
            ExpressionAttributeValues: { ":sub": { S: userSub } },
            ExclusiveStartKey,
        }));
        
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
    try {
        // Safely determine HTTP method using type cast for context compatibility
        const method = (event?.requestContext as any)?.http?.method || event?.httpMethod || "GET";
        if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

        // 1. Validate token and get the actual user sub
        const userSub: string = await validateToken(event);

        // 2. Get all multi-day consulting jobs (SCAN)
        const jobsCommand = new ScanCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            FilterExpression: "job_type = :jobType",
            ExpressionAttributeValues: {
                ":jobType": { S: "multi_day_consulting" }
            }
        });
        const jobResponse: ScanCommandOutput = await dynamodb.send(jobsCommand);
        const items: DynamoDBJobItem[] = (jobResponse.Items as DynamoDBJobItem[] || []);

        if (items.length === 0) {
            return {
                statusCode: 200,
                headers: CORS,
                body: JSON.stringify({
                    message: "Multi-day consulting jobs retrieved successfully",
                    excludedCount: 0,
                    jobs: []
                }),
            };
        }

        // 3. Exclude jobs already applied by this professional
        const appliedJobIds = await getAppliedJobIdsForUser(userSub);
        
        // FIX: Only check for applied jobs if jobId is present.
        const visibleItems = items.filter(it => {
            const jobId = it.jobId?.S;
            return jobId ? !appliedJobIds.has(jobId) : true;
        });

        // 4. Map the visible items to the final response structure
        const jobs: JobResponseItem[] = visibleItems.map(job => {
            
            // Helper to safely parse numbers
            const parseNum = (attr: AttributeValue | undefined): number => 
                attr?.N ? parseFloat(attr.N) : 0;
            
            // Determine meal break status/value
            let mealBreakValue: string | boolean | null = null;
            if (job.meal_break?.S) {
                mealBreakValue = job.meal_break.S;
            } else if (typeof job.meal_break?.BOOL === 'boolean') {
                mealBreakValue = job.meal_break.BOOL;
            }

            // Map and return the structured job object
            return {
                jobId: job.jobId?.S || '',
                jobType: job.job_type?.S || '',
                clinicUserSub: job.clinicUserSub?.S || '',
                clinicId: job.clinicId?.S || '',
                professionalRole: job.professional_role?.S || '',
                jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Consulting Position`,
                description: job.job_description?.S || '',
                requirements: toStrArr(job.requirements), // String Set
                dates: toStrArr(job.dates), // SS, L, or S handled by helper
                startTime: job.start_time?.S || '',
                endTime: job.end_time?.S || '',
                SoftwareRequired: job.clinicSoftware?.S || "",
                hourlyRate: parseNum(job.hourly_rate),
                totalDays: toStrArr(job.dates).length,
                mealBreak: mealBreakValue,
                shiftSpeciality: job.shift_speciality?.S || "",
                freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
                parkingType: job.parkingType?.S || '',
                parkingRate: parseNum(job.parking_rate),
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
                specialRequirements: toStrArr(job.special_requirements), // String Set
                projectScope: job.project_scope?.S || '',
                consultingType: job.consulting_type?.S || '',
                expectedOutcome: job.expected_outcome?.S || '',
                status: job.status?.S || 'active',
                createdAt: job.created_at?.S || '',
                updatedAt: job.updated_at?.S || '',
            };
        });

        // 5. Success Response
        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                message: "Multi-day consulting jobs retrieved successfully",
                excludedCount: appliedJobIds.size,
                jobs
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving multi-day consulting jobs:", error);
        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({
                error: "Failed to retrieve multi-day consulting jobs. Please try again.",
                details: error?.message || String(error)
            }),
        };
    }
};