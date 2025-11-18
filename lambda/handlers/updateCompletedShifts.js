// handlers/updateCompletedShifts.js

"use strict";

const { DynamoDBClient, ScanCommand, QueryCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");

const dynamo = new DynamoDBClient({ region: process.env.REGION || 'us-east-1' });

const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || 'DentiPal-JobApplications';
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || 'DentiPal-JobPostings';
const JOB_POSTINGS_CLINIC_ID_INDEX = 'ClinicIdIndex';
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || 'DentiPal-ProfessionalProfiles'; // <--- MUST BE PRESENT
const REFERRALS_TABLE = process.env.REFERRALS_TABLE || 'DentiPal-Referrals';
const JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX = 'professionalUserSub-index'; // <--- Your GSI Name!
const REFERRALS_REFERRED_USER_SUB_INDEX = 'ReferredUserSubIndex'; // <--- Ensure this GSI exists on DentiPal-Referrals
exports.handler = async (event) => {
    console.log("--- updateCompletedShifts handler started (v9: Deep Debug) ---");
    const now = new Date();
    console.log(`Current time is: ${now.toISOString()}`);
  
    try {
        const scanParams = {
            TableName: JOB_APPLICATIONS_TABLE,
            FilterExpression: "applicationStatus = :status",
            ProjectionExpression: "jobId, professionalUserSub, clinicId",
            ExpressionAttributeValues: { ":status": { S: "scheduled" } },
        };
        console.log("1. Scanning 'DentiPal-JobApplications' for 'scheduled' items...");
        const scanResult = await dynamo.send(new ScanCommand(scanParams));
        const scheduledApplications = scanResult.Items.map(item => unmarshall(item));
        if (scheduledApplications.length === 0) {
            console.log("✅ SUCCESS: Found 0 scheduled applications. Exiting.");
            return { statusCode: 200, body: "No scheduled applications to process." };
        }
        console.log(`2. Found ${scheduledApplications.length} scheduled applications. Now checking each one.`);
        
        let updatesToPerform = [];
        let completedCount = 0;
        
        for (const app of scheduledApplications) {
            console.log(`\n--- Checking Application for Job ID: ${app.jobId} ---`);
            if (!app.clinicId || !app.jobId) {
                console.warn(`⚠️ SKIPPING: Application is missing 'clinicId' or 'jobId'.`);
                continue;
            }
            
            const queryParams = {
                TableName: JOB_POSTINGS_TABLE,
                IndexName: JOB_POSTINGS_CLINIC_ID_INDEX,
                KeyConditionExpression: "clinicId = :cId AND jobId = :jId",
                ExpressionAttributeValues: { ":cId": { S: app.clinicId }, ":jId": { S: app.jobId } }
            };
            const queryResult = await dynamo.send(new QueryCommand(queryParams));
            
            if (queryResult.Items.length === 0) {
                console.warn(`⚠️ SKIPPING: Could not find job posting using GSI for Job ID: ${app.jobId}.`);
                continue;
            }
            
            const job = unmarshall(queryResult.Items[0]);
            console.log("3b. Found job posting. Full data:", JSON.stringify(job, null, 2));

            // CRITICAL GSI PROJECTION CHECK - This should ideally not happen if GSI is configured as "ALL"
            if (!job.clinicUserSub) {
                console.error(`❌ CRITICAL ERROR: The job posting object from the GSI is MISSING the 'clinicUserSub' primary key attribute for Job ID: ${app.jobId}. FIX THE GSI PROJECTION TO 'ALL'.`);
                continue;
            }

            if (job.status !== 'active') {
                console.log(`- SKIPPING: Job status is '${job.status}', not 'active' for Job ID: ${app.jobId}.`);
                continue;
            }

            // Exclude permanent jobs from shift completion check if not applicable
            if (job.job_type === 'permanent') {
                console.log(`- SKIPPING: Job type is 'permanent', not subject to time-based shift completion logic for Job ID: ${app.jobId}.`);
                continue;
            }
            
            let shiftEndDateTime;
            const jobType = job.job_type;
            // Removed direct 'singleDateValue' as 'referenceDateValue' is used strategically below

            // Helper function to ensure time is HH:MM:SS for Date constructor
            const formatTimeForDate = (timeStr) => {
                if (!timeStr) return null;
                const parts = timeStr.split(':');
                if (parts.length === 3) return timeStr; // Already HH:MM:SS
                if (parts.length === 2) return `${timeStr}:00`; // HH:MM -> HH:MM:00
                return timeStr; // Fallback, but might lead to invalid date
            };

            const endTimeFormatted = formatTimeForDate(job.end_time);

            // Logic for multi_day_consulting or multi_day
            if ((jobType === 'multi_day_consulting' || job.job_type === 'multi_day')) {
                let effectiveDate = null;
                
                // Prioritize the 'dates' array if it's properly formed and has content
                if (Array.isArray(job.dates) && job.dates.length > 0) {
                    effectiveDate = [...job.dates].sort().pop(); // Get the latest date
                    console.log(`   - Using Logic C: Combined last date of multi-day from 'dates' array with end_time.`);
                } 
                // Fallback to 'start_date' if 'dates' array is missing or empty/malformed
                else if (job.start_date && typeof job.start_date === 'string') {
                    effectiveDate = job.start_date;
                    console.log(`   - Using Logic C (Fallback): 'dates' array missing/empty/malformed, using 'start_date' for multi-day.`);
                }
                // Another fallback to 'date' if both 'dates' array and 'start_date' are missing/malformed
                else if (job.date && typeof job.date === 'string') {
                    effectiveDate = job.date;
                    console.log(`   - Using Logic C (Fallback): 'dates' array, 'start_date' missing/empty/malformed, using 'date' for multi-day.`);
                }

                if (effectiveDate && typeof effectiveDate === 'string' && endTimeFormatted) {
                    const datePart = effectiveDate.split('T')[0]; // Ensure only date part is used
                    shiftEndDateTime = new Date(`${datePart}T${endTimeFormatted}`);
                } else {
                    // Log a specific warning when a multi-day job has no valid date source
                    console.warn(`⚠️ SKIPPING: Multi-day job ID: ${app.jobId} is of type '${jobType}' but has no valid 'dates' array, 'start_date', or 'date' to determine shift end time. Please check job posting data integrity.`);
                    continue; // Skip this application as no valid date can be determined
                }

            } else if (jobType === 'temporary' && (job.date || job.start_date) && typeof (job.date || job.start_date) === 'string' && endTimeFormatted) {
                // Logic B: For temporary jobs with a simple date string (e.g., "YYYY-MM-DD")
                // Use job.date or job.start_date as the reference for temporary jobs
                const tempDateRef = job.date || job.start_date;
                shiftEndDateTime = new Date(`${tempDateRef.split('T')[0]}T${endTimeFormatted}`);
                 console.log(`   - Using Logic B: Combined simple date (${tempDateRef.split('T')[0]}) with end_time.`);
            
            } else if ((job.date || job.start_date) && typeof (job.date || job.start_date) === 'string' && (job.date || job.start_date).includes('T') && endTimeFormatted) {
                // Logic A: For other jobs where the primary date value is already an ISO string (e.g., "YYYY-MM-DDTHH:MM:SS.sssZ")
                const isoDateRef = job.date || job.start_date;
                const datePart = isoDateRef.split('T')[0];
                shiftEndDateTime = new Date(`${datePart}T${endTimeFormatted}`);
                console.log(`   - Using Logic A: Combined date part (${datePart}) with end_time.`);
            }


            if (!shiftEndDateTime || isNaN(shiftEndDateTime.getTime())) {
                console.warn(`⚠️ SKIPPING: Failed to create a valid shiftEndDateTime for Job ID: ${app.jobId}. 
                    Job Type: ${jobType}, End Time: ${job.end_time}, 
                    Dates Array: ${Array.isArray(job.dates) ? JSON.stringify(job.dates) : 'Not an array or empty'}. 
                    Derived date string attempted (approx): ${ (job.date || job.start_date)?.split('T')[0] || 'N/A' }T${endTimeFormatted}`);
                continue;
            }

            console.log(`4. Comparing current time (${now.toISOString()}) with valid shift end time (${shiftEndDateTime.toISOString()}) for Job ID: ${app.jobId}.`);
            
            if (now > shiftEndDateTime) {
                console.log(`✅ COMPLETE: Shift end time has passed. Queuing for update for Job ID: ${app.jobId}.`);
                completedCount++;
                
                const jobPostingKey = { clinicUserSub: job.clinicUserSub, jobId: job.jobId };
                const applicationKey = { jobId: app.jobId, professionalUserSub: app.professionalUserSub };
                
                console.log(`   - DEEP DEBUG: Key being used for JobPostings update: ${JSON.stringify(jobPostingKey)}`);

                updatesToPerform.push(updateItemStatus(JOB_APPLICATIONS_TABLE, applicationKey, 'applicationStatus', 'completed'));
                updatesToPerform.push(updateItemStatus(JOB_POSTINGS_TABLE, jobPostingKey, 'status', 'inactive'));
              // --- NEW REFERRAL BONUS LOGIC STARTS HERE ---
              const professionalUserSub = app.professionalUserSub;

              // 1. Check if this professional was referred
              const referralQueryParams = {
                  TableName: REFERRALS_TABLE,
                  IndexName: REFERRALS_REFERRED_USER_SUB_INDEX, // <--- YOUR INDEX NAME
                  KeyConditionExpression: "referredUserSub = :pSub",
                  ExpressionAttributeValues: marshall({ ":pSub": professionalUserSub })
              };
              console.log(`   - 5a. Querying ${REFERRALS_TABLE} using GSI '${REFERRALS_REFERRED_USER_SUB_INDEX}' for professional: ${professionalUserSub}`);
              let referredByResult;
              try {
                  referredByResult = await dynamo.send(new QueryCommand(referralQueryParams));
              } catch (queryError) {
                  console.error(`   ❌ Error querying REFERRALS_TABLE with GSI ${REFERRALS_REFERRED_USER_SUB_INDEX}:`, queryError);
                  console.error(`   This often means the GSI does not exist or has incorrect configuration.`);
                  continue; // Skip bonus logic if we can't query referrals
              }
              
              if (referredByResult.Items && referredByResult.Items.length > 0) {
                  const referralRecord = unmarshall(referredByResult.Items[0]);
                  console.log(`   - 5b. Professional ${professionalUserSub} was referred by ${referralRecord.referrerUserSub}. Referral ID: ${referralRecord.referralId}. Current referral status: ${referralRecord.status}`);

                  // 2. Check if this referral is eligible for bonus (status is 'signed_up')
                  if (referralRecord.status === 'signed_up') {
                      console.log(`   - 5c. Referral record status is 'signed_up'. Checking if this is their first completed shift.`);
                      
                      // Count actual completed shifts for this professional
                      const completedShiftsQuery = {
                          TableName: JOB_APPLICATIONS_TABLE,
                          IndexName: JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX, // <--- YOUR INDEX NAME
                          KeyConditionExpression: "professionalUserSub = :pSub",
                          FilterExpression: "applicationStatus = :completedStatus",
                          ExpressionAttributeValues: marshall({
                              ":pSub": professionalUserSub,
                              ":completedStatus": "completed"
                          }),
                          Select: "COUNT"
                      };
                      console.log(`   - 5d. Counting completed shifts for ${professionalUserSub} using GSI '${JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX}'`);
                      let completedShiftsResult;
                      try {
                          completedShiftsResult = await dynamo.send(new QueryCommand(completedShiftsQuery));
                      } catch (queryError) {
                          console.error(`   ❌ Error counting completed shifts with GSI ${JOB_APPLICATIONS_PROFESSIONAL_USER_SUB_INDEX}:`, queryError);
                          console.error(`   This might mean the GSI does not exist or has incorrect configuration on ${JOB_APPLICATIONS_TABLE}.`);
                          continue; // Skip bonus logic if we can't count shifts
                      }
                      
                      const actualCompletedShiftsCount = completedShiftsResult.Count || 0;
                      console.log(`   - 5e. Professional ${professionalUserSub} has ${actualCompletedShiftsCount} actual completed shifts.`);

                      // This is the condition: if the count is 1 (meaning THIS is the first completed one)
                      // This handles cases where the current shift is just being marked "completed".
                      // If actualCompletedShiftsCount is 0, it means the current one is truly the first.
                      // If actualCompletedShiftsCount is 1, it means the current one is being counted.
                      // So, the condition should be if `actualCompletedShiftsCount` is 1 or less (i.e. if it's currently 0 or 1).
                      // However, the `referralRecord.status === 'signed_up'` is the most important guard for *first* shift bonus.
                      // Let's rely primarily on the status. If status is `signed_up`, it means bonus hasn't been paid.
                      
                      const referrerUserSub = referralRecord.referrerUserSub;
                      const BONUS_AMOUNT = 50;

                      // Update referrer's profile
                      const updateReferrerProfileParams = {
                          TableName: PROFESSIONAL_PROFILES_TABLE,
                          Key: marshall({ userSub: referrerUserSub }),
                          UpdateExpression: "SET bonusBalance = if_not_exists(bonusBalance, :start) + :amount, updatedAt = :now",
                          ExpressionAttributeValues: marshall({
                              ":start": 0,
                              ":amount": BONUS_AMOUNT,
                              ":now": now.toISOString()
                          }),
                          ReturnValues: "UPDATED_NEW"
                      };
                      console.log(`   - 5f. Queuing bonus of $${BONUS_AMOUNT} for referrer ${referrerUserSub}.`);
                      updatesToPerform.push(dynamo.send(new UpdateItemCommand(updateReferrerProfileParams)));

                      // Update referral record status
                      const updateReferralStatusParams = {
                          TableName: REFERRALS_TABLE,
                          Key: marshall({ referralId: referralRecord.referralId }),
                          UpdateExpression: "SET #status = :bonusStatus, firstShiftCompletedAt = :now, updatedAt = :now",
                          ExpressionAttributeNames: { "#status": "status" },
                          ExpressionAttributeValues: marshall({
                              ":bonusStatus": "bonus_due",
                              ":now": now.toISOString()
                          }),
                          ConditionExpression: "#status = :signedUpStatus", // Ensure status is still 'signed_up'
                          ExpressionAttributeValues: { // Merge values for marshalling
                              ...marshall({ ":bonusStatus": "bonus_due", ":now": now.toISOString() }),
                              ":signedUpStatus": { S: "signed_up" }
                          }
                      };
                      console.log(`   - 5g. Queuing update for referral record ${referralRecord.referralId} to status 'bonus_due'.`);
                      updatesToPerform.push(dynamo.send(new UpdateItemCommand(updateReferralStatusParams)));
                  } else {
                      console.log(`   - 5h. Referral record status for ${professionalUserSub} is '${referralRecord.status}', not 'signed_up'. Bonus not applicable (already processed or invalid state).`);
                  }
              } else {
                  console.log(`   - 5i. Professional ${professionalUserSub} was not found as a referred user (no matching record in ${REFERRALS_TABLE} with status 'signed_up').`);
              }
              // --- NEW REFERRAL BONUS LOGIC ENDS HERE ---

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

const updateItemStatus = async (tableName, key, statusAttributeName, newStatus) => {
    const updateParams = {
        TableName: tableName,
        Key: marshall(key),
        UpdateExpression: `SET #statusAttr = :newStatus, updatedAt = :now`,
        ExpressionAttributeNames: {
            '#statusAttr': statusAttributeName
        },
        ExpressionAttributeValues: marshall({ 
            ":newStatus": newStatus, 
            ":now": new Date().toISOString() 
        }),
    };
    
    console.log(`   ...queuing update for ${tableName} with key ${JSON.stringify(key)} to set '${statusAttributeName}' to '${newStatus}'`);
    return dynamo.send(new UpdateItemCommand(updateParams));
};