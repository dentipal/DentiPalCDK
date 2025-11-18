    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.handler = void 0;
    const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
    const uuid_1 = require("uuid");
    const utils_1 = require("./utils");
    const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

    const handler = async (event) => {
        try {
            console.log("Received event:", JSON.stringify(event));

            // Extract jobId from the proxy path
            const fullPath = event.pathParameters?.proxy || '';  // Full path will be something like '/applications/3671fee1-12ee-413c-bade-3c2e71223756'
            const pathParts = fullPath.split('/').filter(Boolean);  // Split and remove any empty parts
            
            if (pathParts.length < 2) {
                console.error("jobId is missing in the path parameters");
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "jobId is required in the path parameters"
                    })
                };
            }

            const jobId = pathParts[1];  // jobId will be the second part of the path

            console.log("Job ID extracted from path:", jobId);

            // Extract and validate user token
            const userSub = (0, utils_1.validateToken)(event);  // Validate user token and extract userSub
            console.log(userSub);
            
            const applicationData = JSON.parse(event.body);

            console.log("Parsed application data:", applicationData);

            // Validate required fields in the application request
            if (!applicationData.message || !applicationData.proposedRate || !applicationData.availability) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "Missing required fields in the application data."
                    })
                };
            }

            // Fetch the job posting to get clinicId
            const jobExistsCommand = new client_dynamodb_1.GetItemCommand({
                TableName: "DentiPal-JobApplications",  // Using the correct table name
                Key: {
                    jobId: { S: jobId }
                }
            });

            const jobExists = await dynamodb.send(jobExistsCommand);
            if (!jobExists.Item) {
                return {
                    statusCode: 404,
                    body: JSON.stringify({
                        error: "Job posting not found"
                    })
                };
            } 
            console.log("Job exists:", jobExists);
            console.log("Clinic Id", clinicId)

            // Extract clinicId from the job posting
            const clinicIdFromJob = jobExists.Item.clinicId?.S;
            if (!clinicIdFromJob) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "Clinic ID not found in job posting"
                    })
                };
            }

            console.log("Clinic ID from job:", jobExists.Item.clinicId);

            // Check if the job posting is active
            const jobStatus = jobExists.Item.status?.S || 'active';
            if (jobStatus !== 'active') {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: `Cannot apply to ${jobStatus} job posting`
                    })
                };
            }

            // Check if the user has already applied to this job (allow multiple users to apply, but only once per user)
            console.log("Checking if the user has already applied...");
            const existingApplicationCommand = new client_dynamodb_1.QueryCommand({
                TableName: "DentiPal-JobApplications",  // Using the correct table name
                KeyConditionExpression: "jobId = :jobId",
                FilterExpression: "professionalUserSub = :userSub",
                ExpressionAttributeValues: {
                    ":jobId": { S: jobId },
                    ":userSub": { S: userSub }
                }
            });

            const existingApplication = await dynamodb.send(existingApplicationCommand);
            if (existingApplication.Items && existingApplication.Items.length > 0) {
                console.log("User has already applied to this job.");
                return {
                    statusCode: 409,
                    body: JSON.stringify({
                        error: "You have already applied to this job"
                    })
                };
            }

            const applicationId = (0, uuid_1.v4)();
            const timestamp = new Date().toISOString();

            const applicationItem = {
                jobId: { S: jobId },  // Partition key (jobId)
                professionalUserSub: { S: userSub },  // Sort key (professionalUserSub)
                applicationId: { S: applicationId },
                clinicId: { S: clinicIdFromJob },
                applicationStatus: { S: 'pending' },
                appliedAt: { S: timestamp },
                updatedAt: { S: timestamp }
            };

            // Add optional fields if provided
            if (applicationData.message) {
                applicationItem.applicationMessage = { S: applicationData.message };
            }
            if (applicationData.proposedRate) {
                applicationItem.proposedRate = { N: applicationData.proposedRate.toString() };
            }
            if (applicationData.availability) {
                applicationItem.availability = { S: applicationData.availability };
            }
            if (applicationData.startDate) {
                applicationItem.startDate = { S: applicationData.startDate };
            }
            if (applicationData.notes) {
                applicationItem.notes = { S: applicationData.notes };
            }

            console.log("Item being saved:", JSON.stringify(applicationItem));

            try {
                // Save application to DynamoDB
                await dynamodb.send(new client_dynamodb_1.PutItemCommand({
                    TableName: "DentiPal-JobApplications",  // Table name
                    Item: applicationItem  // Correct item structure
                }));
                console.log("Job application saved successfully.");
            } catch (saveError) {
                console.error("Error saving job application:", saveError);
                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        error: "Failed to save job application.",
                        details: saveError.message
                    })
                };
            }

            // Fetch job details for the response
            let jobInfo = null;
            try {
                console.log("Fetching job details...");
                const jobDetails = jobExists.Item;
                if (jobDetails) {
                    jobInfo = {
                        title: jobDetails.job_title?.S || `${jobDetails.professional_role?.S || 'Professional'} Position`,
                        type: jobDetails.job_type?.S || 'unknown',
                        role: jobDetails.professional_role?.S || '',
                        hourlyRate: jobDetails.hourly_rate?.N ? parseFloat(jobDetails.hourly_rate.N) : undefined,
                        date: jobDetails.date?.S,
                        dates: jobDetails.dates?.SS,
                    };
                }
            }
            catch (jobError) {
                console.warn("Failed to fetch job details:", jobError);
            }

            // Return response with application details
            console.log("Job application submitted successfully.");
            return {
                statusCode: 201,
                body: JSON.stringify({
                    message: "Job application submitted successfully",
                    applicationId,
                    jobId: jobId,
                    status: "pending",
                    appliedAt: timestamp,
                    job: jobInfo
                })
            };
        }
        catch (error) {
            console.error("Error creating job application:", error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: "Failed to submit job application. Please try again.",
                    details: error.message
                })
            };
        }
    };

    exports.handler = handler;
