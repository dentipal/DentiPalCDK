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
    // ... many other fields
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped job object
interface JobResponseItem {
    jobId: string;
    jobType: string;
    clinicUserSub: string;
    clinicId: string;
    professionalRole: string;
    shiftSpeciality: string;
    jobTitle: string;
    requirements: string[];
    date: string;
    description: string;
    startTime: string;
    endTime: string;
    hourlyRate: number | undefined;
    mealBreak: string | boolean | null;
    freeParkingAvailable: boolean;
    parkingType: string;
    parkingRate: number | undefined;
    softwareRequired: string;
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
    status: string;
    createdAt: string;
    updatedAt: string;
}

// Utility: today in UTC "YYYY-MM-DD"
function utcToday(): string {
    const iso = new Date().toISOString();
    return iso.slice(0, 10);
}

// --- NEW: query applied jobIds for this professional via GSI ----

/**
 * Queries DynamoDB to get a Set of job IDs the given professional has applied to.
 * @param userSub The professional's user sub (Partition Key on the GSI).
 * @returns A Set of applied job IDs (strings).
 */
async function getAppliedJobIdsForUser(userSub: string): Promise<Set<string>> {
    const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
    const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

    const set = new Set<string>();
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
        (resp.Items || []).forEach(it => it.jobId?.S && set.add(it.jobId.S));
        
        ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    
    return set;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    try {
        // Logged-in professional
        // validateToken is assumed to return the userSub (string) and throw on failure.
        const userSub: string = await validateToken(event);
        const today = utcToday();

        // Scan upcoming temporary jobs
        const baseParams = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            // Filter: job_type is temporary AND date is >= today (YYYY-MM-DD string comparison)
            FilterExpression: `
                job_type = :jobType AND (
                    #date >= :today
                )
            `,
            ExpressionAttributeNames: { "#date": "date" },
            ExpressionAttributeValues: {
                ":jobType": { S: "temporary" },
                ":today": { S: today },
            },
        };

        const items: DynamoDBJobItem[] = [];
        let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
        
        // Handle pagination for the Scan operation
        do {
            const cmd = new ScanCommand({ ...baseParams, ExclusiveStartKey });
            const resp: ScanCommandOutput = await dynamodb.send(cmd);
            if (resp.Items) items.push(...(resp.Items as DynamoDBJobItem[]));
            ExclusiveStartKey = resp.LastEvaluatedKey;
        } while (ExclusiveStartKey);

        // ---- NEW: get applied jobIds for this professional and exclude them ----
        const appliedJobIds = await getAppliedJobIdsForUser(userSub);
        const visibleItems = (items || []).filter(it => !appliedJobIds.has(it.jobId?.S));

        // Helpers (re-implemented for TypeScript compatibility)
        const num = (x: AttributeValue | undefined): number | undefined => 
            x?.N ? parseFloat(x.N) : undefined;
            
        const bool = (x: AttributeValue | undefined): boolean | undefined => {
            if (typeof x?.BOOL === "boolean") return x.BOOL;
            const s = x?.S?.toLowerCase?.();
            if (s === "true") return true;
            if (s === "false") return false;
            return undefined;
        };
        
        const str = (x: AttributeValue | undefined): string => x?.S || "";
        
        const strOr = (...xs: (AttributeValue | undefined)[]): string => 
            xs.find((v) => v?.S)?.S || "";

        // Map only visible items
        const jobs: JobResponseItem[] = (visibleItems || []).map((job) => {
            // Determine mealBreak value (S, BOOL, or null)
            let mealBreakValue: string | boolean | null = str(job.meal_break);
            if (mealBreakValue === "") {
                mealBreakValue = bool(job.meal_break) ?? null;
            }

            return {
                jobId: str(job.jobId),
                jobType: str(job.job_type),
                clinicUserSub: str(job.clinicUserSub),
                clinicId: str(job.clinicId),
                professionalRole: str(job.professional_role),
                shiftSpeciality: str(job.shift_speciality),
                jobTitle: str(job.job_title) || (job.professional_role?.S ? `${job.professional_role.S} Position` : "Position"),
                requirements: job.requirements?.SS || [],
                date: str(job.date),
                description: str(job.job_description),
                startTime: str(job.start_time),
                endTime: str(job.end_time),
                hourlyRate: num(job.hourly_rate) ?? 0, // Using ?? 0 to match original output structure if undefined
                mealBreak: mealBreakValue,
                freeParkingAvailable: bool(job.freeParkingAvailable) ?? false, // Using ?? false
                parkingType: str(job.parkingType),
                parkingRate: num(job.parking_rate) ?? 0, // Using ?? 0
                softwareRequired: str(job.clinicSoftware),
                location: {
                    addressLine1: str(job.addressLine1),
                    addressLine2: str(job.addressLine2),
                    addressLine3: str(job.addressLine3),
                    city: str(job.city),
                    state: str(job.state),
                    zipCode: str(job.pincode),
                },
            
                contactInfo: {
                    email: str(job.contact_email),
                    phone: str(job.contact_phone),
                },
                specialRequirements: job.special_requirements?.SS || [],
                status: str(job.status) || "active",
                createdAt: strOr(job.created_at, job.createdAt),
                updatedAt: strOr(job.updated_at, job.updatedAt),
            };
        });

        return {
            statusCode: 200,
            headers: CORS,
            body: JSON.stringify({
                message: "Temporary jobs (today or in the future) retrieved successfully",
                excludedCount: appliedJobIds.size, // helpful for debugging
                count: jobs.length,
                jobs,
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving temporary jobs:", error);
        return {
            statusCode: 500,
            headers: CORS,
            body: JSON.stringify({
                error: "Failed to retrieve temporary jobs. Please try again.",
                details: error?.message || String(error),
            }),
        };
    }
};