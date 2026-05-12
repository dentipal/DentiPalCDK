import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { extractAuthFromEvent, AuthContext } from "./utils";
import { corsHeaders } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

function toStrArr(attr: any): string[] {
  if (!attr) return [];
  if (Array.isArray(attr.SS)) return attr.SS;
  if (Array.isArray(attr.L)) {
    return attr.L
      .map((v: any) => (v && typeof v.S === "string" ? v.S : null))
      .filter(Boolean) as string[];
  }
  if (typeof attr.S === "string") return [attr.S];
  return [];
}

function invitationIsPast(inv: any): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (Array.isArray(inv.dates) && inv.dates.length > 0) {
    return inv.dates.every((d: string) => {
      const jd = new Date(d);
      return !Number.isNaN(jd.getTime()) && jd < today;
    });
  }

  const dateStr = inv.date || inv.startDate || inv.start_date;
  if (!dateStr) return false;
  const jobDate = new Date(dateStr);
  if (Number.isNaN(jobDate.getTime())) return false;
  return jobDate < today;
}

// --- Types ---

export interface GetJobInvitationsResult {
  status: number;
  body: any;
}

// --- Core logic (callable from handler OR chatbot toolExecutor) ---

export async function runGetJobInvitations(auth: AuthContext): Promise<GetJobInvitationsResult> {
  if (!process.env.JOB_INVITATIONS_TABLE || !process.env.JOB_POSTINGS_TABLE) {
    return { status: 500, body: { error: "Table names are missing from the environment variables" } };
  }

  const professionalUserSub = auth.userSub;
  if (!professionalUserSub) {
    return { status: 401, body: { error: "Unauthorized: No user identity found." } };
  }

  let allItems: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const queryParams: QueryCommandInput = {
      TableName: process.env.JOB_INVITATIONS_TABLE!,
      IndexName: "ProfessionalIndex",
      KeyConditionExpression: "professionalUserSub = :userSub",
      FilterExpression: "attribute_not_exists(invitationStatus) OR (invitationStatus <> :accepted AND invitationStatus <> :declined)",
      ExpressionAttributeValues: {
        ":userSub": { S: professionalUserSub },
        ":accepted": { S: "accepted" },
        ":declined": { S: "declined" },
      },
      ExclusiveStartKey: lastKey,
    };

    const resp = await dynamodb.send(new QueryCommand(queryParams));
    if (resp.Items) allItems.push(...resp.Items);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  console.log(`Found ${allItems.length} invitations for professional ${professionalUserSub}`);

  const invitations: any[] = [];

  for (const item of allItems) {
    const invitation: any = {
      invitationId: item.invitationId?.S || "",
      jobId: item.jobId?.S || "",
      clinicId: item.clinicId?.S || "",
      professionalUserSub: item.professionalUserSub?.S || "",
      invitationStatus: item.invitationStatus?.S || "pending",
      sentAt: item.sentAt?.S || "",
      updatedAt: item.updatedAt?.S || "",
    };

    if (item.message?.S) invitation.message = item.message.S;
    if (item.rateOffered?.N) invitation.rateOffered = parseFloat(item.rateOffered.N);
    if (item.validUntil?.S) invitation.validUntil = item.validUntil.S;

    try {
      const jobQuery: QueryCommandInput = {
        TableName: process.env.JOB_POSTINGS_TABLE!,
        IndexName: "jobId-index-1",
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: { ":jobId": { S: invitation.jobId } },
      };

      const jobResponse = await dynamodb.send(new QueryCommand(jobQuery));

      if (jobResponse.Items && jobResponse.Items[0]) {
        const job = jobResponse.Items[0];

        invitation.jobTitle = job.job_title?.S || "Unknown Job Title";
        invitation.jobType = job.job_type?.S || "Unknown";
        invitation.jobDescription = job.job_description?.S || "No description available";
        invitation.jobRate = job.rate?.N
          ? parseFloat(job.rate.N)
          : (job.pay_type?.S === "per_transaction"
            ? (job.rate_per_transaction?.N ? parseFloat(job.rate_per_transaction.N) : null)
            : job.pay_type?.S === "percentage_of_revenue"
              ? (job.revenue_percentage?.N ? parseFloat(job.revenue_percentage.N) : null)
              : (job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : null));
        invitation.jobSalaryMin = job.salary_min?.N ? parseFloat(job.salary_min.N) : null;
        invitation.jobSalaryMax = job.salary_max?.N ? parseFloat(job.salary_max.N) : null;
        invitation.jobHours = job.hours?.N ? parseFloat(job.hours.N) : null;
        invitation.jobHoursPerDay = job.hours_per_day?.N ? parseFloat(job.hours_per_day.N) : null;
        invitation.jobEmploymentType = job.employment_type?.S || "Unknown Employment Type";
        invitation.jobBenefits = job.benefits?.SS || [];
        invitation.startDate = job.start_date?.S || "";
        invitation.softwareRequired = job.clinicSoftware?.S || "";
        invitation.freeParkingAvailable = job.freeParkingAvailable?.BOOL || false;
        invitation.parkingType = job.parkingType?.S || "";
        invitation.parkingRate = job.parking_rate?.N ? parseFloat(job.parking_rate.N) : 0;
        invitation.shiftSpeciality = job.shift_speciality?.S || "";
        invitation.jobRequirements = job.requirements?.SS || [];
        invitation.mealBreak = job.meal_break?.S || job.meal_break?.BOOL || false;
        invitation.date = job.date?.S;
        invitation.payType = job.work_schedule?.S;
        invitation.dates = toStrArr(job.dates);
        invitation.jobstartTime = job.start_time?.S;
        invitation.jobendTime = job.end_time?.S;

        invitation.jobLocation = {
          addressLine1: job.addressLine1?.S || "",
          addressLine2: job.addressLine2?.S || "",
          addressLine3: job.addressLine3?.S || "",
          city: job.city?.S || "",
          state: job.state?.S || "",
          zipCode: job.pincode?.S || "",
        };

        invitation.contactInfo = {
          email: job.contact_email?.S || "",
          phone: job.contact_phone?.S || "",
        };

        invitation.professionalRole = job.professional_role?.S || "Unknown Role";
        invitation.professionalRoles = toStrArr(job.professional_roles);
        invitation.workLocationType = job.work_location_type?.S || "";
        invitation.payType = job.pay_type?.S || "per_hour";
        invitation.clinicSoftware = toStrArr(job.clinicSoftware);
        invitation.jobDescription = job.job_description?.S || invitation.jobDescription;
      }
    } catch (jobError: any) {
      console.error(`Failed to fetch job details for JobId: ${invitation.jobId}:`, jobError.message || jobError);
    }

    if (invitationIsPast(invitation)) continue;
    invitations.push(invitation);
  }

  invitations.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  return {
    status: 200,
    body: {
      message: "Invitations fetched successfully.",
      invitations,
      totalCount: invitations.length,
    },
  };
}

// --- Thin API Gateway adapter ---

export const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    let auth: AuthContext;
    try {
      auth = extractAuthFromEvent(event);
    } catch (authError: any) {
      return json(event, 401, { error: authError.message || "Invalid access token" });
    }

    const { status, body } = await runGetJobInvitations(auth);
    return json(event, status, body);
  } catch (error: any) {
    console.error("Error fetching invitations:", error);
    return json(event, 500, { error: "Failed to retrieve invitations.", details: error.message });
  }
};
