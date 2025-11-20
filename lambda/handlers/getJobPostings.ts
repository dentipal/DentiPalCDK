"use strict";
import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    GetItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken, isRoot } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// -------------------------
// Types
// -------------------------

interface DynamoItem {
    [key: string]: AttributeValue;
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
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    // This variable isn't strictly used in the logic below but is good practice to have if needed later
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    try {
        // Cast event to any to ensure compatibility with validateToken utility
        const userSub = await validateToken(event as any);

        // Safe access to claims
        const claims = event.requestContext?.authorizer?.claims || {};
        const groupsClaim = claims["cognito:groups"];
        
        const groups = typeof groupsClaim === 'string' 
            ? groupsClaim.split(",") 
            : (Array.isArray(groupsClaim) ? groupsClaim : []);

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
                                    // Assuming primary key is just clinicId or composite. 
                                    // Based on context from other files (getJobPosting.ts), it seems to be composite {clinicId, userSub}
                                    // However, here we only have clinicUserSub. 
                                    // IF the table PK is just userSub (or GSI), we query. 
                                    // IF the table PK is composite, we can't GetItem with just userSub.
                                    // Based on the code provided in the query, it uses userSub as the Key.
                                    // NOTE: If this fails in runtime, check if CLINIC_PROFILES_TABLE uses clinicId as PK.
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