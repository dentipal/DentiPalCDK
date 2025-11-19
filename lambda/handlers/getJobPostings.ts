"use strict";
import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    GetItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { validateToken, isRoot } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// -------------------------
// Types
// -------------------------

interface DynamoItem {
    [key: string]: AttributeValue;
}

interface LambdaEvent {
    pathParameters?: {
        proxy?: string;
    };
    requestContext?: {
        authorizer?: {
            claims?: { [key: string]: string };
        };
    };
    headers?: {
        Authorization?: string;
    };
    body?: string;
    [key: string]: any;
}

interface LambdaResponse {
    statusCode: number;
    body: string;
}

// -------------------------
// Function: Get all clinic userSubs (Root only)
// -------------------------
async function getAllClinicUserSubs(): Promise<string[]> {
    const command = new ScanCommand({
        TableName: process.env.CLINIC_PROFILES_TABLE,
        ProjectionExpression: "userSub",
    });

    const response = await dynamodb.send(command);

    return (response.Items || []).map(
        (item: DynamoItem) => item.userSub?.S || ""
    );
}

// -------------------------
// Handler: Retrieve job postings (clinic or root)
// -------------------------
export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        const userSub = await validateToken(event);

        const groups =
            event.requestContext?.authorizer?.claims?.["cognito:groups"]?.split(",") ||
            [];

        let clinicUserSubs: string[] = [];

        if (isRoot(groups)) {
            clinicUserSubs = await getAllClinicUserSubs();
        } else {
            clinicUserSubs = [userSub];
        }

        const jobPostings: any[] = [];

        for (const clinicUserSub of clinicUserSubs) {
            try {
                const postingsCommand = new QueryCommand({
                    TableName: process.env.JOB_POSTINGS_TABLE,
                    KeyConditionExpression: "clinicUserSub = :clinicUserSub",
                    ExpressionAttributeValues: {
                        ":clinicUserSub": { S: clinicUserSub }
                    }
                });

                const postingsResponse = await dynamodb.send(postingsCommand);

                if (postingsResponse.Items) {
                    for (const item of postingsResponse.Items) {
                        const job: any = {
                            jobId: item.jobId?.S || "",
                            clinicUserSub: item.clinicUserSub?.S || "",
                            jobType: item.job_type?.S || "",
                            professionalRole: item.professional_role?.S || "",
                            status: item.status?.S || "active",
                            createdAt: item.createdAt?.S || "",
                            updatedAt: item.updatedAt?.S || ""
                        };

                        // Optional fields
                        if (item.job_title?.S) job.jobTitle = item.job_title.S;
                        if (item.job_description?.S) job.jobDescription = item.job_description.S;

                        if (item.hourly_rate?.N) job.hourlyRate = parseFloat(item.hourly_rate.N);
                        if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
                        if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);

                        if (item.date?.S) job.date = item.date.S;
                        if (item.dates?.SS) job.dates = item.dates.SS;
                        if (item.hours?.N) job.hours = parseFloat(item.hours.N);

                        // -------------------------
                        // Fetch clinic details
                        // -------------------------
                        try {
                            const clinicCommand = new GetItemCommand({
                                TableName: process.env.CLINIC_PROFILES_TABLE,
                                Key: {
                                    userSub: { S: clinicUserSub }
                                }
                            });

                            const clinicResponse = await dynamodb.send(clinicCommand);

                            if (clinicResponse.Item) {
                                const clinic = clinicResponse.Item;

                                job.clinic = {
                                    name: clinic.clinic_name?.S || "Unknown Clinic",
                                    city: clinic.city?.S || "",
                                    state: clinic.state?.S || "",
                                    contactName:
                                        `${clinic.primary_contact_first_name?.S || ""} ${clinic.primary_contact_last_name?.S || ""}`
                                            .trim() || "Contact",
                                };
                            }
                        } catch (clinicError) {
                            console.warn(
                                `Failed to fetch clinic details for ${clinicUserSub}:`,
                                clinicError
                            );
                        }

                        jobPostings.push(job);
                    }
                }
            } catch (postingError) {
                console.warn(
                    `Failed to fetch job postings for clinic ${clinicUserSub}:`,
                    postingError
                );
                continue;
            }
        }

        // -------------------------
        // Sort: Most recent first
        // -------------------------
        jobPostings.sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
        );

        return {
            statusCode: 200,
            body: JSON.stringify({
                status: "success",
                jobPostings,
                totalCount: jobPostings.length
            })
        };
    } catch (error: any) {
        console.error("Error retrieving job postings:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: `Failed to retrieve job postings: ${error.message}`
            })
        };
    }
};
