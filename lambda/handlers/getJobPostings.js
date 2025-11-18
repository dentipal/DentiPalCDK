"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

// Function to get all clinic user subs (for root users)
async function getAllClinicUserSubs() {
    const command = new client_dynamodb_1.ScanCommand({
        TableName: process.env.CLINIC_PROFILES_TABLE,
        ProjectionExpression: "userSub",
    });
    const response = await dynamodb.send(command);
    return (response.Items || []).map(item => item.userSub.S);
}

// Function to retrieve all job postings for the current user (clinic-specific or all if root)
const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event);
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];

        // For clinic users, get their own job postings
        // For root users, get all job postings
        let clinicUserSubs = [];
        if ((0, utils_1.isRoot)(groups)) {
            clinicUserSubs = await getAllClinicUserSubs(); // Root users can see all job postings
        } else {
            clinicUserSubs = [userSub]; // Regular users can only see their own job postings
        }

        const jobPostings = [];

        for (const clinicUserSub of clinicUserSubs) {
            try {
                const postingsCommand = new client_dynamodb_1.QueryCommand({
                    TableName: process.env.JOB_POSTINGS_TABLE,
                    KeyConditionExpression: "clinicUserSub = :clinicUserSub",
                    ExpressionAttributeValues: { ":clinicUserSub": { S: clinicUserSub } },
                });

                const postingsResponse = await dynamodb.send(postingsCommand);

                if (postingsResponse.Items) {
                    for (const item of postingsResponse.Items) {
                        const job = {
                            jobId: item.jobId?.S || '',
                            clinicUserSub: item.clinicUserSub?.S || '',
                            jobType: item.job_type?.S || '',
                            professionalRole: item.professional_role?.S || '',
                            status: item.status?.S || 'active',
                            createdAt: item.createdAt?.S || '',
                            updatedAt: item.updatedAt?.S || '',
                        };

                        // Add optional job fields
                        if (item.job_title?.S) job.jobTitle = item.job_title.S;
                        if (item.job_description?.S) job.jobDescription = item.job_description.S;
                        if (item.hourly_rate?.N) job.hourlyRate = parseFloat(item.hourly_rate.N);
                        if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
                        if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);
                        if (item.date?.S) job.date = item.date.S;
                        if (item.dates?.SS) job.dates = item.dates.SS;
                        if (item.hours?.N) job.hours = parseFloat(item.hours.N);

                        // Fetch clinic details
                        try {
                            const clinicCommand = new client_dynamodb_1.GetItemCommand({
                                TableName: process.env.CLINIC_PROFILES_TABLE,
                                Key: {
                                    userSub: { S: clinicUserSub }
                                }
                            });

                            const clinicResponse = await dynamodb.send(clinicCommand);
                            if (clinicResponse.Item) {
                                const clinic = clinicResponse.Item;
                                job.clinic = {
                                    name: clinic.clinic_name?.S || 'Unknown Clinic',
                                    city: clinic.city?.S || '',
                                    state: clinic.state?.S || '',
                                    contactName: `${clinic.primary_contact_first_name?.S || ''} ${clinic.primary_contact_last_name?.S || ''}`.trim() || 'Contact',
                                };
                            }
                        } catch (clinicError) {
                            console.warn(`Failed to fetch clinic details for ${clinicUserSub}:`, clinicError);
                        }

                        // Add the job posting to the array
                        jobPostings.push(job);
                    }
                }
            } catch (postingError) {
                console.warn(`Failed to fetch job postings for clinic ${clinicUserSub}:`, postingError);
                continue;
            }
        }

        // Sort by creation date (most recent first)
        jobPostings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return {
            statusCode: 200,
            body: JSON.stringify({
                status: "success",
                jobPostings,
                totalCount: jobPostings.length
            }),
        };
    } catch (error) {
        console.error("Error retrieving job postings:", error);
        return { statusCode: 500, body: JSON.stringify({ error: `Failed to retrieve job postings: ${error.message}` }) };
    }
};

exports.handler = handler;
