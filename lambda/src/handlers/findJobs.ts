import { 
  DynamoDBClient, 
  ScanCommand, 
  GetItemCommand, 
  AttributeValue,
  ScanCommandInput,
  ScanCommandOutput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

// --- Interfaces ---

interface ClinicInfo {
  name: string;
  contactName: string;
}

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
  date?: string;
  dates?: string[];
  startDate?: string;
  hours?: number;
  startTime?: string;
  endTime?: string;
  
  // Location details
  city?: string;
  state?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;

  // Enriched Data
  clinic?: ClinicInfo;
}

// --- Helper Functions ---

/**
 * Helper to fetch clinic info given clinic userSub.
 */
async function fetchClinicInfo(clinicUserSub: string): Promise<ClinicInfo | undefined> {
  try {
    const clinicCommand = new GetItemCommand({
      TableName: process.env.CLINIC_PROFILES_TABLE,
      Key: { userSub: { S: clinicUserSub } },
      ProjectionExpression: "clinic_name, primary_contact_first_name, primary_contact_last_name",
    });
    
    const clinicResponse = await dynamodb.send(clinicCommand);
    
    if (clinicResponse.Item) {
      const clinic = clinicResponse.Item;
      const firstName = clinic.primary_contact_first_name?.S || "";
      const lastName = clinic.primary_contact_last_name?.S || "";

      return {
        name: clinic.clinic_name?.S || "Unknown Clinic",
        contactName: `${firstName} ${lastName}`.trim() || "Contact",
      };
    }
  } catch (e) {
    console.warn(`Failed to fetch clinic details for ${clinicUserSub}:`, e);
  }
  return undefined;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Define CORS headers
 

  try {
    const jobPostings: JobPosting[] = [];
    
    // Explicitly type the key to handle DynamoDB pagination
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;

    // Paginate through all active jobs
    do {
      const scanParams: ScanCommandInput = {
        TableName: process.env.JOB_POSTINGS_TABLE,
        FilterExpression: "#st = :active",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":active": { S: "active" } },
        ExclusiveStartKey,
      };

      const scanCommand = new ScanCommand(scanParams);
      
      // Explicitly type the response to access LastEvaluatedKey safely
      const scanResponse: ScanCommandOutput = await dynamodb.send(scanCommand);

      if (scanResponse.Items) {
        for (const item of scanResponse.Items) {
          // Base object construction
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

          // Rate/Salary fields
          if (item.hourly_rate?.N) job.hourlyRate = parseFloat(item.hourly_rate.N);
          if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
          if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);

          // Date/Time specific fields based on jobType
          if (item.job_type?.S === 'temporary') {
            if (item.date?.S) job.date = item.date.S;
            if (item.hours?.N) job.hours = parseFloat(item.hours.N);
            if (item.start_time?.S) job.startTime = item.start_time.S;
            if (item.end_time?.S) job.endTime = item.end_time.S;
          } else if (item.job_type?.S === 'multi_day_consulting') {
            if (item.dates?.SS) job.dates = item.dates.SS;
            if (item.start_time?.S) job.startTime = item.start_time.S;
            if (item.end_time?.S) job.endTime = item.end_time.S;
          } else if (item.job_type?.S === 'permanent') {
            if (item.start_date?.S) job.startDate = item.start_date.S;
          }

          // Location details
          if (item.city?.S) job.city = item.city.S;
          if (item.state?.S) job.state = item.state.S;
          if (item.addressLine1?.S) job.addressLine1 = item.addressLine1.S;
          if (item.addressLine2?.S) job.addressLine2 = item.addressLine2.S;
          if (item.addressLine3?.S) job.addressLine3 = item.addressLine3.S;

          // Enrich with clinic info (name, contact) if available
          const clinicUserSub = item.clinicUserSub?.S;
          if (clinicUserSub) {
            const clinicInfo = await fetchClinicInfo(clinicUserSub);
            if (clinicInfo) {
              job.clinic = clinicInfo;
            }
          }

          jobPostings.push(job);
        }
      }

      ExclusiveStartKey = scanResponse.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // Sort by createdAt descending (newest first). Fallback to 0.
    jobPostings.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime() || 0;
      const tb = new Date(b.createdAt).getTime() || 0;
      return tb - ta;
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
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
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: `Failed to retrieve active job postings: ${error.message || "unknown"}`,
      }),
    };
  }
};