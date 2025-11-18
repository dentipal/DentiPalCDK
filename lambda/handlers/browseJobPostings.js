"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils"); // Import validateToken function

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = await validateToken(event);
        const queryParams = event.queryStringParameters || {};

        // Optional filters
        const jobType = queryParams.jobType; // temporary, multi_day_consulting, permanent
        const professionalRole = queryParams.role; // from valid professional roles
        const shiftSpeciality = queryParams.speciality; // general_dentistry, oral_surgeon, etc.
        const minRate = queryParams.minRate ? parseFloat(queryParams.minRate) : undefined;
        const maxRate = queryParams.maxRate ? parseFloat(queryParams.maxRate) : undefined;
        const dateFrom = queryParams.dateFrom; // ISO date string
        const dateTo = queryParams.dateTo; // ISO date string
        const assistedHygiene = queryParams.assistedHygiene === 'true';
        const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;

        // Validate professional role if provided
        if (professionalRole && !['dentist', 'hygienist', 'assistant'].includes(professionalRole)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid professional role. Valid options: dentist, hygienist, assistant`
                })
            };
        }

        // Build filter expression
        const filterExpressions = [];
        const expressionAttributeValues = {};
        filterExpressions.push("#status = :active");
        expressionAttributeValues[":active"] = { S: "active" };

        if (jobType) {
            filterExpressions.push("job_type = :jobType");
            expressionAttributeValues[":jobType"] = { S: jobType };
        }

        if (professionalRole) {
            filterExpressions.push("professional_role = :role");
            expressionAttributeValues[":role"] = { S: professionalRole };
        }

        if (shiftSpeciality) {
            filterExpressions.push("shift_speciality = :speciality");
            expressionAttributeValues[":speciality"] = { S: shiftSpeciality };
        }

        if (assistedHygiene) {
            filterExpressions.push("assisted_hygiene = :assistedHygiene");
            expressionAttributeValues[":assistedHygiene"] = { BOOL: assistedHygiene };
        }

        const scanCommand = new ScanCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            FilterExpression: filterExpressions.join(" AND "),
            ExpressionAttributeNames: {
                "#status": "status"
            },
            ExpressionAttributeValues: expressionAttributeValues,
            Limit: limit * 2 // Get more items to account for additional filtering
        });

        const scanResponse = await dynamodb.send(scanCommand);
        const jobPostings = [];

        if (scanResponse.Items) {
            for (const item of scanResponse.Items) {
                const job = {
                    jobId: item.jobId?.S || '',
                    clinicUserSub: item.clinicUserSub?.S || '',
                    clinicId: item.clinicId?.S || '', // Include clinicId
                    jobType: item.job_type?.S || '',
                    professionalRole: item.professional_role?.S || '',
                    shiftSpeciality: item.shift_speciality?.S || '',
                    assistedHygiene: item.assisted_hygiene?.BOOL || false,
                    status: item.status?.S || 'active',
                    SoftwareRequired:item.clinicSoftware?.S || "",
                    postedAt: item.createdAt?.S || '',
                    updatedAt: item.updatedAt?.S || '',
                    jobTitle: item.job_title?.S || '',
                    jobDescription: item.job_description?.S || '',
                    hourlyRate: item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : 0,
                    salaryMin: item.salary_min?.N ? parseFloat(item.salary_min.N) : 0,
                    salaryMax: item.salary_max?.N ? parseFloat(item.salary_max.N) : 0,
                    date: item.date?.S || '',
                    dates: item.dates?.SS || [],
                    hours: item.hours?.N ? parseFloat(item.hours.N) : 0,
                    hoursPerDay: item.hours_per_day?.N ? parseFloat(item.hours_per_day.N) : 0,
                    totalDays: item.total_days?.N ? parseFloat(item.total_days.N) : 0,
                    employmentType: item.employment_type?.S || '',
                    benefits: item.benefits?.SS || [],
                    requirements: item.requirements?.SS || [],
                    mealBreak: item.meal_break?.BOOL || false,
                    parkingType: item.parkingType?.S || '',
                    parkingRate: item.parking_rate?.N ? parseFloat(item.parking_rate.N) : 0,
                    location: {
                        addressLine1: item.addressLine1?.S || '',
                        addressLine2: item.addressLine2?.S || '',
                        addressLine3: item.addressLine3?.S || '',
                        city: item.city?.S || '',
                        state: item.state?.S || '',
                        zipCode: item.pincode?.S || ''
                    },
                    contactInfo: {
                        email: item.contact_email?.S || '',
                        phone: item.contact_phone?.S || ''
                    },
                    specialRequirements: item.special_requirements?.SS || [],
                    projectScope: item.project_scope?.S || '',
                    consultingType: item.consulting_type?.S || '',
                    expectedOutcome: item.expected_outcome?.S || '',
                };

                // Fetch clinic details for location
                try {
                    const clinicCommand = new GetItemCommand({
                        TableName: process.env.CLINIC_PROFILES_TABLE,
                        Key: {
                            userSub: { S: job.clinicUserSub }
                        }
                    });

                    const clinicResponse = await dynamodb.send(clinicCommand);
                    if (clinicResponse.Item) {
                        const clinic = clinicResponse.Item;
                        job.clinic = {
                            name: clinic.clinic_name?.S || 'Unknown Clinic',
                            city: clinic.city?.S || '',
                            state: clinic.state?.S || '',
                            practiceType: clinic.practice_type?.S || '',
                            primaryPracticeArea: clinic.primary_practice_area?.S || '',
                            contactName: `${clinic.primary_contact_first_name?.S || ''} ${clinic.primary_contact_last_name?.S || ''}`.trim() || 'Contact',
                            freeParkingAvailable: clinic.free_parking_available?.BOOL || false,
                            assistedHygieneAvailable: clinic.assisted_hygiene_available?.BOOL || false,
                        };
                    }
                } catch (clinicError) {
                    console.warn(`Failed to fetch clinic details for ${job.clinicUserSub}:`, clinicError);
                    // Continue without clinic details
                }

                jobPostings.push(job);

                // Stop if we have enough results
                if (jobPostings.length >= limit) break;
            }
        }

        // Sort by posted date (most recent first)
        jobPostings.sort((a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime());

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Job postings retrieved successfully",
                jobPostings,
                totalCount: jobPostings.length,
                filters: {
                    jobType: jobType || 'all',
                    professionalRole: professionalRole || 'all',
                    shiftSpeciality: shiftSpeciality || 'all',
                    minRate,
                    maxRate,
                    dateFrom,
                    dateTo,
                    assistedHygiene: assistedHygiene || false,
                    limit
                }
            })
        };
    } catch (error) {
        console.error("Error browsing job postings:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve job postings. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;
