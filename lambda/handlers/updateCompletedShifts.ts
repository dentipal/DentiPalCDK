import { 
    DynamoDBClient, 
    ScanCommand, 
    QueryCommand, 
    UpdateItemCommand,
    AttributeValue, // Used for typed DynamoDB structures
    ScanCommandInput,
    QueryCommandInput,
    UpdateItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

// --- 1. Environment and Constants ---

// Set up DynamoDB Client
const REGION: string = process.env.REGION || 'us-east-1';
const dynamo: DynamoDBClient = new DynamoDBClient({ region: REGION });

// Table Names (Using non-null assertion '!' if expected to be present, or fallbacks)
const JOB_APPLICATIONS_TABLE: string = process.env.JOB_APPLICATIONS_TABLE || 'DentiPal-JobApplications';
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE || 'DentiPal-JobPostings';
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE || 'DentiPal-ProfessionalProfiles';
const REFERRALS_TABLE: string = process.env.REFERRALS_TABLE || 'DentiPal-Referrals';

// Index Names
const JOB_POSTINGS_CLINIC_ID_INDEX: string = 'ClinicIdIndex';
const JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX: string = 'professionalUserSub-index';
const REFERRALS_REFERRED_USER_SUB_INDEX: string = 'ReferredUserSubIndex';

const BONUS_AMOUNT: number = 50;

// --- 2. Type Definitions for Unmarshalled Data ---

/** Interface for unmarshalled Job Application items being scanned/queried. */
interface JobApplication {
    jobId: string;
    professionalUserSub: string;
    clinicId: string;
    applicationStatus: string; // 'scheduled' | 'completed' | 'canceled'
    // Other fields that might exist but are not used in logic:
    [key: string]: any; 
}

/** Interface for unmarshalled Job Posting items. */
interface JobPosting {
    clinicUserSub: string;
    jobId: string;
    clinicId: string;
    status: string; // 'active' | 'inactive'
    job_type: string; // 'temporary' | 'multi_day' | 'multi_day_consulting' | 'permanent'
    end_time?: string; // e.g., "17:00"
    date?: string; // e.g., "2024-12-25" or ISO string
    start_date?: string; // e.g., "2024-12-25" or ISO string
    dates?: string[]; // Array of date strings for multi-day jobs
    [key: string]: any; 
}

/** Interface for unmarshalled Referral Record items. */
interface ReferralRecord {
    referralId: string;
    referrerUserSub: string;
    referredUserSub: string;
    status: string; // 'signed_up' | 'bonus_due' | 'paid'
    [key: string]: any; 
}

/** Type for the simple key objects used in unmarshall/marshall for updates. */
type KeyObject = { [key: string]: string | number };

/** Type for the standard Lambda response structure */
interface LambdaResponse {
    statusCode: number;
    body: string;
}

// --- 3. Utility Function ---

/**
 * Helper to update the status of an item in a DynamoDB table.
 * @param tableName - The name of the table to update.
 * @param key - The key object (PK and SK if applicable, e.g., { jobId: 'x', professionalUserSub: 'y' }).
 * @param statusAttributeName - The DynamoDB attribute name for the status field (e.g., 'applicationStatus').
 * @param newStatus - The new status value.
 */
const updateItemStatus = async (
    tableName: string, 
    key: KeyObject, 
    statusAttributeName: string, 
    newStatus: string
): Promise<any> => {
    const now: string = new Date().toISOString();
    
    const updateParams: UpdateItemCommandInput = {
        TableName: tableName,
        Key: marshall(key),
        UpdateExpression: `SET #statusAttr = :newStatus, updatedAt = :now`,
        ExpressionAttributeNames: {
            '#statusAttr': statusAttributeName
        },
        ExpressionAttributeValues: marshall({ 
            ":newStatus": newStatus, 
            ":now": now 
        }) as Record<string, AttributeValue>, // Type assertion for ExpressionAttributeValues
    };
    
    console.log(` ...queuing update for ${tableName} with key ${JSON.stringify(key)} to set '${statusAttributeName}' to '${newStatus}'`);
    return dynamo.send(new UpdateItemCommand(updateParams));
};

// --- 4. Handler Function ---

export const handler = async (event: any): Promise<LambdaResponse> => {
    console.log("--- updateCompletedShifts handler started (v9: Deep Debug) ---");
    const now: Date = new Date();
    console.log(`Current time is: ${now.toISOString()}`);
 
    try {
        // Step 1: Scan for scheduled applications
        const scanParams: ScanCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            FilterExpression: "applicationStatus = :status",
            ProjectionExpression: "jobId, professionalUserSub, clinicId",
            ExpressionAttributeValues: { ":status": { S: "scheduled" } },
        };
        
        console.log("1. Scanning 'DentiPal-JobApplications' for 'scheduled' items...");
        const scanResult = await dynamo.send(new ScanCommand(scanParams));
        
        const scheduledApplications: JobApplication[] = scanResult.Items 
            ? scanResult.Items.map(item => unmarshall(item) as JobApplication) 
            : [];
            
        if (scheduledApplications.length === 0) {
            console.log("✅ SUCCESS: Found 0 scheduled applications. Exiting.");
            return { statusCode: 200, body: "No scheduled applications to process." };
        }
        
        console.log(`2. Found ${scheduledApplications.length} scheduled applications. Now checking each one.`);
        
        const updatesToPerform: Promise<any>[] = [];
        let completedCount: number = 0;
        
        for (const app of scheduledApplications) {
            console.log(`\n--- Checking Application for Job ID: ${app.jobId} ---`);
            
            if (!app.clinicId || !app.jobId) {
                console.warn(`⚠️ SKIPPING: Application is missing 'clinicId' or 'jobId'.`);
                continue;
            }
            
            // Step 2: Query job posting details
            const queryParams: QueryCommandInput = {
                TableName: JOB_POSTINGS_TABLE,
                IndexName: JOB_POSTINGS_CLINIC_ID_INDEX,
                KeyConditionExpression: "clinicId = :cId AND jobId = :jId",
                ExpressionAttributeValues: { 
                    ":cId": { S: app.clinicId }, 
                    ":jId": { S: app.jobId } 
                } as Record<string, AttributeValue>,
            };
            
            const queryResult = await dynamo.send(new QueryCommand(queryParams));
            
            if (!queryResult.Items || queryResult.Items.length === 0) {
                console.warn(`⚠️ SKIPPING: Could not find job posting using GSI for Job ID: ${app.jobId}.`);
                continue;
            }
            
            const job: JobPosting = unmarshall(queryResult.Items[0]) as JobPosting;
            console.log("3b. Found job posting. Full data:", JSON.stringify(job, null, 2));

            if (!job.clinicUserSub) {
                console.error(`❌ CRITICAL ERROR: Job posting is MISSING 'clinicUserSub'. FIX GSI PROJECTION TO 'ALL'.`);
                continue;
            }

            if (job.status !== 'active') {
                console.log(`- SKIPPING: Job status is '${job.status}', not 'active' for Job ID: ${app.jobId}.`);
                continue;
            }

            if (job.job_type === 'permanent') {
                console.log(`- SKIPPING: Job type is 'permanent', not subject to time-based shift completion logic for Job ID: ${app.jobId}.`);
                continue;
            }
            
            let shiftEndDateTime: Date | null = null;
            const jobType: string = job.job_type;
            
            // Helper function to ensure time is HH:MM:SS for Date constructor
            const formatTimeForDate = (timeStr: string | undefined): string | null => {
                if (!timeStr) return null;
                const parts = timeStr.split(':');
                if (parts.length === 3) return timeStr; // Already HH:MM:SS
                if (parts.length === 2) return `${timeStr}:00`; // HH:MM -> HH:MM:00
                return null; 
            };

            const endTimeFormatted: string | null = formatTimeForDate(job.end_time);
            
            if (endTimeFormatted) {
                let datePart: string | null = null;

                if ((jobType === 'multi_day_consulting' || jobType === 'multi_day')) {
                    // Prioritize the latest date from the 'dates' array
                    if (Array.isArray(job.dates) && job.dates.length > 0) {
                        datePart = [...job.dates].sort().pop() || null; // Get the latest date
                        console.log(` - Using Logic C: Combined last date of multi-day from 'dates' array with end_time.`);
                    } 
                    // Fallback to 'start_date'
                    else if (job.start_date && typeof job.start_date === 'string') {
                        datePart = job.start_date.split('T')[0];
                        console.log(` - Using Logic C (Fallback): Using 'start_date' for multi-day.`);
                    }
                    // Another fallback to 'date'
                    else if (job.date && typeof job.date === 'string') {
                        datePart = job.date.split('T')[0];
                        console.log(` - Using Logic C (Fallback): Using 'date' for multi-day.`);
                    }

                } else if (jobType === 'temporary') {
                    // Logic B: For temporary jobs, use simple date string (date or start_date)
                    const tempDateRef = job.date || job.start_date;
                    if (tempDateRef && typeof tempDateRef === 'string') {
                        datePart = tempDateRef.split('T')[0];
                        console.log(` - Using Logic B: Combined simple date (${datePart}) with end_time.`);
                    }
                } else if ((job.date || job.start_date) && typeof (job.date || job.start_date) === 'string') {
                    // Logic A: For other jobs where date is an ISO string (extract date part)
                    const isoDateRef = job.date || job.start_date;
                    datePart = isoDateRef.split('T')[0];
                    console.log(` - Using Logic A: Combined date part (${datePart}) with end_time.`);
                }
                
                if (datePart) {
                    // Construct the shift end time using the determined date and formatted time
                    const dateTimeString = `${datePart}T${endTimeFormatted}`;
                    const potentialDate = new Date(dateTimeString);
                    if (!isNaN(potentialDate.getTime())) {
                        shiftEndDateTime = potentialDate;
                    }
                }
            }


            if (!shiftEndDateTime || isNaN(shiftEndDateTime.getTime())) {
                console.warn(`⚠️ SKIPPING: Failed to create a valid shiftEndDateTime for Job ID: ${app.jobId}. 
                     Job Type: ${jobType}, End Time: ${job.end_time}.`);
                continue;
            }

            console.log(`4. Comparing current time (${now.toISOString()}) with valid shift end time (${shiftEndDateTime.toISOString()}) for Job ID: ${app.jobId}.`);
            
            if (now > shiftEndDateTime) {
                console.log(`✅ COMPLETE: Shift end time has passed. Queuing for update for Job ID: ${app.jobId}.`);
                completedCount++;
                
                const jobPostingKey: KeyObject = { clinicUserSub: job.clinicUserSub, jobId: job.jobId };
                const applicationKey: KeyObject = { jobId: app.jobId, professionalUserSub: app.professionalUserSub };
                
                updatesToPerform.push(updateItemStatus(JOB_APPLICATIONS_TABLE, applicationKey, 'applicationStatus', 'completed'));
                updatesToPerform.push(updateItemStatus(JOB_POSTINGS_TABLE, jobPostingKey, 'status', 'inactive'));
                
                // --- REFERRAL BONUS LOGIC ---
                const professionalUserSub: string = app.professionalUserSub;

                // 1. Check if this professional was referred
                const referralQueryParams: QueryCommandInput = {
                    TableName: REFERRALS_TABLE,
                    IndexName: REFERRALS_REFERRED_USER_SUB_INDEX, 
                    KeyConditionExpression: "referredUserSub = :pSub",
                    ExpressionAttributeValues: marshall({ ":pSub": professionalUserSub }) as Record<string, AttributeValue>,
                };
                console.log(` - 5a. Querying ${REFERRALS_TABLE} using GSI '${REFERRALS_REFERRED_USER_SUB_INDEX}' for professional: ${professionalUserSub}`);
                
                let referredByResult;
                try {
                    referredByResult = await dynamo.send(new QueryCommand(referralQueryParams));
                } catch (queryError) {
                    console.error(` - ❌ Error querying REFERRALS_TABLE:`, queryError);
                    continue; 
                }
                
                if (referredByResult.Items && referredByResult.Items.length > 0) {
                    const referralRecord: ReferralRecord = unmarshall(referredByResult.Items[0]) as ReferralRecord;
                    
                    // 2. Check if this referral is eligible for bonus (status is 'signed_up')
                    if (referralRecord.status === 'signed_up') {
                        console.log(` - 5c. Referral record status is 'signed_up'. Checking for completed shifts...`);
                        
                        // Count actual completed shifts for this professional
                        const completedShiftsQuery: QueryCommandInput = {
                            TableName: JOB_APPLICATIONS_TABLE,
                            IndexName: JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX, 
                            KeyConditionExpression: "professionalUserSub = :pSub",
                            FilterExpression: "applicationStatus = :completedStatus",
                            ExpressionAttributeValues: marshall({
                                ":pSub": professionalUserSub,
                                ":completedStatus": "completed"
                            }) as Record<string, AttributeValue>,
                            Select: "COUNT"
                        };
                        
                        let completedShiftsResult;
                        try {
                             completedShiftsResult = await dynamo.send(new QueryCommand(completedShiftsQuery));
                        } catch (queryError) {
                            console.error(` - ❌ Error counting completed shifts:`, queryError);
                            continue;
                        }
                        
                        const actualCompletedShiftsCount: number = completedShiftsResult.Count || 0;
                        console.log(` - 5e. Professional ${professionalUserSub} has ${actualCompletedShiftsCount} actual completed shifts.`);

                        // The logic should award the bonus if this is truly the *first* completed shift.
                        // Since we are *about* to mark the current shift as completed, if the count *before* this moment
                        // (which is what the query provides, potentially including this job if it was already updated 
                        // by a previous run or concurrent process) is 1 or less, we proceed. 
                        // A safer check relies on the status of the referral record itself (`signed_up`).
                        
                        const referrerUserSub: string = referralRecord.referrerUserSub;

                        // Update referrer's profile (add bonus)
                        const updateReferrerProfileParams: UpdateItemCommandInput = {
                            TableName: PROFESSIONAL_PROFILES_TABLE,
                            Key: marshall({ userSub: referrerUserSub }) as Record<string, AttributeValue>,
                            UpdateExpression: "SET bonusBalance = if_not_exists(bonusBalance, :start) + :amount, updatedAt = :now",
                            ExpressionAttributeValues: marshall({
                                ":start": BONUS_AMOUNT, // Use BONUS_AMOUNT as start to avoid DynamoDB type issues if it's a number
                                ":amount": BONUS_AMOUNT,
                                ":now": now.toISOString()
                            }) as Record<string, AttributeValue>,
                            ReturnValues: "UPDATED_NEW"
                        };
                        console.log(` - 5f. Queuing bonus of $${BONUS_AMOUNT} for referrer ${referrerUserSub}.`);
                        updatesToPerform.push(dynamo.send(new UpdateItemCommand(updateReferrerProfileParams)));

                        // Update referral record status (conditional update for safety)
                        const updateReferralStatusParams: UpdateItemCommandInput = {
                            TableName: REFERRALS_TABLE,
                            Key: marshall({ referralId: referralRecord.referralId }) as Record<string, AttributeValue>,
                            UpdateExpression: "SET #status = :bonusStatus, firstShiftCompletedAt = :now, updatedAt = :now",
                            ExpressionAttributeNames: { "#status": "status" },
                            ExpressionAttributeValues: marshall({
                                ":bonusStatus": "bonus_due",
                                ":now": now.toISOString(),
                                // Note: ":signedUpStatus" must be of type S for ConditionExpression
                            }) as Record<string, AttributeValue>,
                            ConditionExpression: "#status = :signedUpStatus", 
                            ExpressionAttributeValues: {
                                ...marshall({ ":bonusStatus": "bonus_due", ":now": now.toISOString() }),
                                ":signedUpStatus": { S: "signed_up" }
                            } as Record<string, AttributeValue> // Overwrite for ConditionExpression types
                        };
                        
                        console.log(` - 5g. Queuing update for referral record ${referralRecord.referralId} to status 'bonus_due'.`);
                        updatesToPerform.push(dynamo.send(new UpdateItemCommand(updateReferralStatusParams)));
                    } else {
                        console.log(` - 5h. Referral record status for ${professionalUserSub} is '${referralRecord.status}'. Bonus not applicable.`);
                    }
                } else {
                    console.log(` - 5i. Professional ${professionalUserSub} was not found as a referred user.`);
                }
                // --- END REFERRAL BONUS LOGIC ---

            } else {
                console.log(`- NOT COMPLETE: Shift end time has not passed yet for Job ID: ${app.jobId}.`);
            }
        }
    
        if (updatesToPerform.length > 0) {
            console.log(`\n5. EXECUTING UPDATES: Found ${completedCount} completed shifts.`);
            await Promise.all(updatesToPerform);
            console.log("✅✅✅ All database updates completed successfully. ✅✅✅");
        } else {
            console.log("\n5. FINISHED: No shifts were ready to be marked as completed.");
        }

        return { statusCode: 200, body: "Job completion check finished successfully." };

    } catch (error) {
        console.error("❌❌❌ FATAL ERROR in updateCompletedShifts handler: ❌❌❌", error);
        throw error;
    }
};

// Original JS export style. Using `export const handler` is more common in TS/ESM.
// exports.handler = handler;