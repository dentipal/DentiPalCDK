// index.ts
import {
    DynamoDBClient,
    ScanCommand,
    GetItemCommand,
    AttributeValue,
    ScanCommandOutput,
    GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

// Define interfaces for type safety

interface ClinicInfo {
    name: string;
    contactName: string;
}

// Interface for the transformed job object to be returned in the response
interface JobPosting {
    jobId: string;
    jobType: string;
    professionalRole: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    // Common fields
    jobTitle?: string;
    jobDescription?: string;
    // Rate/Salary fields
    hourlyRate?: number;
    salaryMin?: number;
    salaryMax?: number;
    // Date/Time fields
    date?: string; // temporary (single date)
    hours?: number; // temporary
    dates?: string[]; // multi_day_consulting (array of dates)
    startTime?: string;
    endTime?: string;
    startDate?: string; // permanent
    // Location details
    city?: string;
    state?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    // Enriched data
    clinic?: ClinicInfo;
    [key: string]: any; // Allow other properties
}

// Define CORS headers
const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
};

/**
 * Helper to fetch clinic info given clinic userSub.
 * This is primarily for clinic name and contact.
 * @param clinicUserSub The userSub (Partition Key) of the clinic profile.
 * @returns ClinicInfo object or undefined.
 */
async function fetchClinicInfo(clinicUserSub: string): Promise<ClinicInfo | undefined> {
    try {
        const clinicCommand = new GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Key: { userSub: { S: clinicUserSub } },
            ProjectionExpression: "clinic_name, primary_contact_first_name, primary_contact_last_name",
        });
        const clinicResponse: GetItemCommandOutput = await dynamodb.send(clinicCommand);

        if (clinicResponse.Item) {
            const clinic = clinicResponse.Item;
            
            const contactName = (`${clinic.primary_contact_first_name?.S || ""} ${clinic.primary_contact_last_name?.S || ""}`).trim() || "Contact";
            
            return {
                name: clinic.clinic_name?.S || "Unknown Clinic",
                contactName: contactName,
            };
        }
    } catch (e) {
        console.warn(`Failed to fetch clinic details for ${clinicUserSub}:`, e);
    }
    return undefined;
}

/**
 * AWS Lambda handler to retrieve and transform all active job postings.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const jobPostings: JobPosting[] = [];
        let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;

        // Paginate through all active jobs
        do {
            const scanParams = {
                TableName: process.env.JOB_POSTINGS_TABLE,
                FilterExpression: "#st = :active",
                ExpressionAttributeNames: { "#st": "status" },
                ExpressionAttributeValues: { ":active": { S: "active" } },
                ExclusiveStartKey,
            };

            const scanCommand = new ScanCommand(scanParams);
            const scanResponse: ScanCommandOutput = await dynamodb.send(scanCommand);

            if (scanResponse.Items) {
                // Use Promise.all to fetch all clinic info concurrently
                const itemsToProcess = scanResponse.Items.map(item => ({
                    item,
                    clinicUserSub: item.clinicUserSub?.S,
                }));
                
                const clinicInfoPromises = itemsToProcess.map(async ({ clinicUserSub }) => {
                    return clinicUserSub ? fetchClinicInfo(clinicUserSub) : Promise.resolve(undefined);
                });

                const allClinicInfo = await Promise.all(clinicInfoPromises);

                // Process items and merge with clinic info
                scanResponse.Items.forEach((item, index) => {
                    const job: JobPosting = {
                        jobId: item.jobId?.S || "",
                        jobType: item.job_type?.S || "",
                        professionalRole: item.professional_role?.S || "",
                        status: item.status?.S || "active",
                        createdAt: item.createdAt?.S || "",
                        updatedAt: item.updatedAt?.S || "",
                    };

                    // Common fields
                    if (item.job_title?.S) job.jobTitle = item.job_title.S;
                    if (item.job_description?.S) job.jobDescription = item.job_description.S;

                    // Rate/Salary fields (N type to float)
                    if (item.hourly_rate?.N) job.hourlyRate = parseFloat(item.hourly_rate.N);
                    if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
                    if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);

                    // Date/Time specific fields
                    if (item.job_type?.S === 'temporary') {
                        if (item.date?.S) job.date = item.date.S; // Single date
                        if (item.hours?.N) job.hours = parseFloat(item.hours.N);
                        if (item.start_time?.S) job.startTime = item.start_time.S;
                        if (item.end_time?.S) job.endTime = item.end_time.S;
                    } else if (item.job_type?.S === 'multi_day_consulting') {
                        if (item.dates?.SS) job.dates = item.dates.SS; // Array of dates (String Set)
                        if (item.start_time?.S) job.startTime = item.start_time.S;
                        if (item.end_time?.S) job.endTime = item.end_time.S;
                    } else if (item.job_type?.S === 'permanent') {
                        if (item.start_date?.S) job.startDate = item.start_date.S;
                    }

                    // Enrich with clinic info (name, contact)
                    const clinicInfo = allClinicInfo[index];
                    if (clinicInfo) {
                        job.clinic = clinicInfo;
                    }

                    jobPostings.push(job);
                });
            }

            ExclusiveStartKey = scanResponse.LastEvaluatedKey;
        } while (ExclusiveStartKey);

        // Sort by createdAt descending (newest first).
        jobPostings.sort((a, b) => {
            const ta = new Date(a.createdAt).getTime() || 0;
            const tb = new Date(b.createdAt).getTime() || 0;
            return tb - ta;
        });

        // Response
        return {
            statusCode: 200,
            headers: headers,
            body: JSON.stringify({
                status: "success",
                jobPostings,
                totalCount: jobPostings.length,
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving active job postings:", error);
        return {
            statusCode: 500,
            headers: headers,
            body: JSON.stringify({
                error: `Failed to retrieve active job postings: ${error.message || "unknown"}`,
            }),
        };
    }
};