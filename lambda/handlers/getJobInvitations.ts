import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    ScanCommandInput,
    QueryCommandInput,
  } from "@aws-sdk/client-dynamodb";
  import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
  import { validateToken } from "./utils";
  
  // DynamoDB Client
  const dynamodb = new DynamoDBClient({
    region: process.env.REGION,
  });
  
  // Normalize DynamoDB Attribute → string[]
  function toStrArr(attr: any): string[] {
    if (!attr) return [];
    if (Array.isArray(attr.SS)) return attr.SS; // String Set
    if (Array.isArray(attr.L)) {
      return attr.L
        .map((v: any) => (v && typeof v.S === "string" ? v.S : null))
        .filter(Boolean) as string[];
    }
    if (typeof attr.S === "string") return [attr.S];
    return [];
  }
  
  export const handler: APIGatewayProxyHandler = async (
    event
  ): Promise<APIGatewayProxyResult> => {
    try {
      console.log("JOB_INVITATIONS_TABLE:", process.env.JOB_INVITATIONS_TABLE);
      console.log("JOB_POSTINGS_TABLE:", process.env.JOB_POSTINGS_TABLE);
  
      if (!process.env.JOB_INVITATIONS_TABLE || !process.env.JOB_POSTINGS_TABLE) {
        return {
          statusCode: 500,
          body: JSON.stringify({
            error: "Table names are missing from the environment variables",
          }),
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        };
      }
  
      // Validate token and extract professionalUserSub
      const professionalUserSub = await validateToken(event);
  
      if (!professionalUserSub) {
        return {
          statusCode: 401,
          body: JSON.stringify({
            error: "Unauthorized: No user identity found.",
          }),
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        };
      }
  
      const queryParams = event.queryStringParameters || {};
      const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
  
      // Filter only sent invitations
      const scanParams: ScanCommandInput = {
        TableName: process.env.JOB_INVITATIONS_TABLE!,
        FilterExpression:
          "professionalUserSub = :userSub AND invitationStatus = :status",
        ExpressionAttributeValues: {
          ":userSub": { S: professionalUserSub },
          ":status": { S: "sent" },
        },
        Limit: limit,
      };
  
      const scanCommand = new ScanCommand(scanParams);
      const scanResponse = await dynamodb.send(scanCommand);
  
      const invitations: any[] = [];
  
      if (scanResponse.Items) {
        for (const item of scanResponse.Items) {
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
          if (item.rateOffered?.N)
            invitation.rateOffered = parseFloat(item.rateOffered.N);
          if (item.validUntil?.S) invitation.validUntil = item.validUntil.S;
  
          try {
            console.log(
              `Querying JOB_POSTINGS_TABLE with jobId: ${invitation.jobId}`
            );
  
            const jobQuery: QueryCommandInput = {
              TableName: process.env.JOB_POSTINGS_TABLE!,
              IndexName: "jobId-index",
              KeyConditionExpression: "jobId = :jobId",
              ExpressionAttributeValues: {
                ":jobId": { S: invitation.jobId },
              },
            };
  
            const jobCommand = new QueryCommand(jobQuery);
            const jobResponse = await dynamodb.send(jobCommand);
  
            console.log("Job Response:", jobResponse);
  
            if (jobResponse.Items && jobResponse.Items[0]) {
              const job = jobResponse.Items[0];
  
              invitation.jobTitle = job.job_title?.S || "Unknown Job Title";
              invitation.jobType = job.job_type?.S || "Unknown";
              invitation.jobDescription =
                job.job_description?.S || "No description available";
              invitation.jobHourlyRate = job.hourly_rate?.N
                ? parseFloat(job.hourly_rate.N)
                : null;
  
              invitation.jobSalaryMin = job.salary_min?.N
                ? parseFloat(job.salary_min.N)
                : null;
              invitation.jobSalaryMax = job.salary_max?.N
                ? parseFloat(job.salary_max.N)
                : null;
  
              invitation.jobHours = job.hours?.N
                ? parseFloat(job.hours.N)
                : null;
  
              invitation.jobHoursPerDay = job.hours_per_day?.N
                ? parseFloat(job.hours_per_day.N)
                : null;
  
              invitation.jobEmploymentType =
                job.employment_type?.S || "Unknown Employment Type";
  
              invitation.jobBenefits = job.benefits?.SS || [];
  
              invitation.startDate = job.start_date?.S || "";
              invitation.softwareRequired = job.clinicSoftware?.S || "";
  
              invitation.freeParkingAvailable =
                job.freeParkingAvailable?.BOOL || false;
  
              invitation.parkingType = job.parkingType?.S || "";
              invitation.parkingRate = job.parking_rate?.N
                ? parseFloat(job.parking_rate.N)
                : 0;
  
              invitation.shiftSpeciality = job.shift_speciality?.S || "";
  
              invitation.jobRequirements = job.requirements?.SS || [];
              invitation.mealBreak =
                job.meal_break?.S || job.meal_break?.BOOL || false;
  
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
  
              invitation.professionalRole =
                job.professional_role?.S || "Unknown Role";
            }
          } catch (jobError: any) {
            console.warn(
              `Failed to fetch job details for JobId: ${invitation.jobId}:`,
              jobError
            );
          }
  
          invitations.push(invitation);
        }
      }
  
      invitations.sort(
        (a, b) =>
          new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
      );
  
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Sent invitations fetched successfully.",
          invitations,
          totalCount: invitations.length,
          filters: {
            status: "sent",
            limit,
          },
        }),
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      };
    } catch (error: any) {
      console.error("Error fetching invitations:", error);
  
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to retrieve invitations.",
          details: error.message,
        }),
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      };
    }
  };
  