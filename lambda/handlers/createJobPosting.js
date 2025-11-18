"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const uuid_1 = require("uuid");
const utils_1 = require("./utils");
const professionalRoles_1 = require("./professionalRoles");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

// Validation functions for each job type
const validateTemporaryJob = (jobData) => {
    if (!jobData.date || !jobData.hours || !jobData.hourly_rate) {
        return "Temporary job requires: date, hours, hourly_rate";
    }
    const jobDate = new Date(jobData.date);
    if (isNaN(jobDate.getTime())) {
        return "Invalid date format. Use ISO date string.";
    }
    if (jobData.hours < 1 || jobData.hours > 12) {
        return "Hours must be between 1 and 12";
    }
    if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
        return "Hourly rate must be between $10 and $200";
    }
    return null;
};

const validateMultiDayConsulting = (jobData) => {
    if (!jobData.dates || !jobData.hours_per_day || !jobData.hourly_rate || !jobData.total_days) {
        return "Multi-day consulting requires: dates, hours_per_day, hourly_rate, total_days";
    }
    if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
        return "Dates must be a non-empty array";
    }
    // Validate all dates
    for (const date of jobData.dates) {
        const jobDate = new Date(date);
        if (isNaN(jobDate.getTime())) {
            return `Invalid date format: ${date}. Use ISO date string.`;
        }
    }
    if (jobData.dates.length !== jobData.total_days) {
        return "Number of dates must match total_days";
    }
    if (jobData.hours_per_day < 1 || jobData.hours_per_day > 12) {
        return "Hours per day must be between 1 and 12";
    }
    return null;
};

const validatePermanentJob = (jobData) => {
    if (!jobData.employment_type || !jobData.salary_min || !jobData.salary_max || !jobData.benefits) {
        return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
    }
    if (jobData.salary_min < 20000 || jobData.salary_min > 500000) {
        return "Minimum salary must be between $20,000 and $500,000";
    }
    if (jobData.salary_max < jobData.salary_min) {
        return "Maximum salary must be greater than minimum salary";
    }
    if (!Array.isArray(jobData.benefits)) {
        return "Benefits must be an array";
    }
    const validEmploymentTypes = ['full_time', 'part_time'];
    if (!validEmploymentTypes.includes(jobData.employment_type)) {
        return `Invalid employment_type. Valid options: ${validEmploymentTypes.join(', ')}`;
    }
    return null;
};

const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user
        const jobData = JSON.parse(event.body);

        // Validate common required fields
        if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Required fields: job_type, professional_role, shift_speciality"
                })
            };
        }

        // Validate job type
        const validJobTypes = ['temporary', 'multi_day_consulting', 'permanent'];
        if (!validJobTypes.includes(jobData.job_type)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid job_type. Valid options: ${validJobTypes.join(', ')}`
                })
            };
        }

        // Validate professional role using the imported validation
        if (!professionalRoles_1.VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid professional_role. Valid options: ${professionalRoles_1.VALID_ROLE_VALUES.join(', ')}`
                })
            };
        }

        // Job type specific validation
        let validationError = null;
        switch (jobData.job_type) {
            case 'temporary':
                validationError = validateTemporaryJob(jobData);
                break;
            case 'multi_day_consulting':
                validationError = validateMultiDayConsulting(jobData);
                break;
            case 'permanent':
                validationError = validatePermanentJob(jobData);
                break;
        }
        if (validationError) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: validationError })
            };
        }

        const jobId = (0, uuid_1.v4)();
        const timestamp = new Date().toISOString();

        // Fetch clinic address details
        const clinicCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: {
                clinicId: { S: jobData.clinicId }
            }
        });

        const clinicResponse = await dynamodb.send(clinicCommand);
        if (!clinicResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Clinic not found" })
            };
        }

        const clinicAddress = {
            addressLine1: clinicResponse.Item.addressLine1.S,
            addressLine2: clinicResponse.Item.addressLine2.S,
            addressLine3: clinicResponse.Item.addressLine3.S,
            fullAddress: `${clinicResponse.Item.addressLine1.S} ${clinicResponse.Item.addressLine2.S} ${clinicResponse.Item.addressLine3.S}`,
            city: clinicResponse.Item.city.S,
            state: clinicResponse.Item.state.S,
            pincode: clinicResponse.Item.pincode.S
        };

        // Fetch profile details from the Clinic Profiles Table
        const profileCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE, // This is the table that holds the profile data
            Key: {
                clinicId: { S: jobData.clinicId },
                userSub: { S: userSub }
            }
        });

        const profileResponse = await dynamodb.send(profileCommand);
        if (!profileResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Profile not found for this clinic" })
            };
        }

        const clinicProfile = profileResponse.Item;
        const profileData = {
            bookingOutPeriod: clinicProfile.booking_out_period?.S || "immediate", // Default to "immediate"
            clinicSoftware: clinicProfile.clinic_software?.S || "Unknown", // Default to "Unknown"
            freeParkingAvailable: clinicProfile.free_parking_available?.BOOL || false,
            parkingType: clinicProfile.parking_type?.S || "N/A", // Default to "N/A"
            practiceType: clinicProfile.practice_type?.S || "General", // Default to "General"
            primaryPracticeArea: clinicProfile.primary_practice_area?.S || "General Dentistry"
        };

        // Build base DynamoDB item (common fields)
        const item = {
            clinicUserSub: { S: userSub },
            jobId: { S: jobId },
            clinicId: { S: jobData.clinicId },  // Ensure clinicId is included here
            job_type: { S: jobData.job_type },
            professional_role: { S: jobData.professional_role },
            shift_speciality: { S: jobData.shift_speciality },
            assisted_hygiene: { BOOL: jobData.assisted_hygiene || false },
            status: { S: jobData.status || 'active' },
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
            addressLine1: { S: clinicAddress.addressLine1 },
            addressLine2: { S: clinicAddress.addressLine2 },
            addressLine3: { S: clinicAddress.addressLine3 },
            fullAddress: { S: clinicAddress.fullAddress },
            city: { S: clinicAddress.city },
            state: { S: clinicAddress.state },
            pincode: { S: clinicAddress.pincode },
            bookingOutPeriod: { S: profileData.bookingOutPeriod },
            clinicSoftware: { S: profileData.clinicSoftware },
            freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
            parkingType: { S: profileData.parkingType },
            practiceType: { S: profileData.practiceType },
            primaryPracticeArea: { S: profileData.primaryPracticeArea }
        };

        // Add job type specific fields
        let responseData = {
            message: "Job posting created successfully",
            jobId,
            job_type: jobData.job_type,
            professional_role: jobData.professional_role
        };

        switch (jobData.job_type) {
            case 'temporary':
                const tempJob = jobData;
                item.date = { S: tempJob.date };
                item.hours = { N: tempJob.hours.toString() };
                item.meal_break = { BOOL: tempJob.meal_break || false };
                item.hourly_rate = { N: tempJob.hourly_rate.toString() };
                item.start_time = { S: tempJob.start_time };  // Storing start time
                item.end_time = { S: tempJob.end_time };  // Storing end time
                if (jobData.job_title)
                    item.job_title = { S: jobData.job_title };
                if (jobData.job_description)
                    item.job_description = { S: jobData.job_description };
                if (jobData.requirements && jobData.requirements.length > 0) {
                    item.requirements = { SS: jobData.requirements };
                }
                responseData.date = tempJob.date;
                responseData.hours = tempJob.hours;
                responseData.hourly_rate = tempJob.hourly_rate;
                break;
            case 'multi_day_consulting':
                const consultingJob = jobData;
                item.dates = { SS: consultingJob.dates };
                item.hours_per_day = { N: consultingJob.hours_per_day.toString() };
                item.total_days = { N: consultingJob.total_days.toString() };
                item.meal_break = { BOOL: consultingJob.meal_break || false };
                item.hourly_rate = { N: consultingJob.hourly_rate.toString() };
                item.start_time = { S: consultingJob.start_time };  // Storing start time
                item.end_time = { S: consultingJob.end_time };  // Storing end time
                if (jobData.project_duration)
                    item.project_duration = { S: jobData.project_duration };
                if (jobData.job_title)
                    item.job_title = { S: jobData.job_title };
                if (jobData.job_description)
                    item.job_description = { S: jobData.job_description };
                if (jobData.requirements && jobData.requirements.length > 0) {
                    item.requirements = { SS: jobData.requirements };
                }
                responseData.dates = consultingJob.dates;
                responseData.total_days = consultingJob.total_days;
                responseData.hourly_rate = consultingJob.hourly_rate;
                break;
            case 'permanent':
                const permanentJob = jobData;
                item.job_title = { S: permanentJob.job_title };  // Added job title
                item.job_description = { S: permanentJob.job_description };  // Added job description
                item.employment_type = { S: permanentJob.employment_type };
                item.salary_min = { N: permanentJob.salary_min.toString() };
                item.salary_max = { N: permanentJob.salary_max.toString() };
                item.benefits = { SS: permanentJob.benefits };
                if (permanentJob.vacation_days) {
                    item.vacation_days = { N: permanentJob.vacation_days.toString() };
                }
                if (permanentJob.work_schedule) {
                    item.work_schedule = { S: permanentJob.work_schedule };
                }
                if (permanentJob.start_date) {
                    item.start_date = { S: permanentJob.start_date };
                }
                if (jobData.requirements && jobData.requirements.length > 0) {
                    item.requirements = { SS: jobData.requirements };
                }
                responseData.employment_type = permanentJob.employment_type;
                responseData.salary_range = `$${permanentJob.salary_min.toLocaleString()} - $${permanentJob.salary_max.toLocaleString()}`;
                responseData.benefits = permanentJob.benefits;
                break;
        }

        // Save the job posting in DynamoDB
        await dynamodb.send(new client_dynamodb_1.PutItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Item: item
        }));

        return {
            statusCode: 201,
            body: JSON.stringify(responseData)
        };

    } catch (error) {
        console.error("Error creating job posting:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.handler = handler;
