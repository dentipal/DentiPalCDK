import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    GetItemCommandInput,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBStreamEvent, DynamoDBStreamHandler } from "aws-lambda";

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Define a type for the structure of a single DynamoDB record
// This maps the generic DynamoDB JSON format to AWS SDK v3 AttributeValues for easier usage
interface ReferralProcessingRecord {
    eventName: 'INSERT' | 'MODIFY' | 'REMOVE';
    dynamodb: {
        NewImage?: {
            applicationStatus: { S: string };
            professionalUserSub: { S: string };
            [key: string]: AttributeValue;
        };
        Keys: {
            jobId: { S: string };
            [key: string]: AttributeValue;
        };
        [key: string]: any;
    };
    [key: string]: any;
}

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent): Promise<void> => {
    console.log("Received event:", JSON.stringify(event, null, 2));

    try {
        if (!event || !event.Records) {
            console.log("No records found in event");
            return; 
        }

        // Cast event.Records to our custom type
        const records = event.Records as unknown as ReferralProcessingRecord[];

        // Loop through ALL records. 
        // We do not 'return' inside the loop, ensuring the whole batch is processed.
        for (const record of records) {
            
            // Wrap individual record processing in a try/catch so one bad record doesn't fail the whole batch
            try {
                console.log("Processing record:", JSON.stringify(record, null, 2));

                // We only care about MODIFY events (status updates) that have a NewImage
                if (record.eventName === 'MODIFY' && record.dynamodb.NewImage) {
                    
                    // Validation: Ensure required fields exist
                    if (!record.dynamodb.NewImage.applicationStatus?.S ||
                        !record.dynamodb.Keys.jobId?.S ||
                        !record.dynamodb.NewImage.professionalUserSub?.S) {
                        console.warn("Skipping record due to missing key fields.");
                        continue;
                    }

                    const newStatus: string = record.dynamodb.NewImage.applicationStatus.S;
                    const jobId: string = record.dynamodb.Keys.jobId.S;
                    const professionalUserSub: string = record.dynamodb.NewImage.professionalUserSub.S;

                    console.log(`Processing Job ID: ${jobId} with status: ${newStatus}`);

                    // 1. Check status: Only award bonus when job is 'completed'
                    if (newStatus !== 'completed') {
                        continue; 
                    }

                    // 2. Query Referrals Table to find who referred this professional
                    // Assuming the 'REFERRALS_TABLE' stores the referral link: PK = friendEmail (or sub)
                    const referralQueryInput: GetItemCommandInput = {
                        TableName: process.env.REFERRALS_TABLE,
                        Key: { friendEmail: { S: professionalUserSub } }
                    };

                    const referralQueryCommand = new GetItemCommand(referralQueryInput);
                    const referralResult = await dynamodb.send(referralQueryCommand);

                    if (!referralResult.Item || !referralResult.Item.referrerUserSub?.S) {
                        console.log("No referral record found for this user, skipping bonus award.");
                        continue;
                    }

                    // 3. Get referrer info
                    const referrerUserSub: string = referralResult.Item.referrerUserSub.S;
                    const referralBonus: number = 50; 

                    // 4. Update Bonus for the Referrer
                    // This assumes the REFERRALS_TABLE (or a shared table) also holds a record for the referrer's balance
                    const bonusUpdateInput: UpdateItemCommandInput = {
                        TableName: process.env.REFERRALS_TABLE,
                        Key: { referrerUserSub: { S: referrerUserSub } },
                        UpdateExpression: "SET referralBonus = if_not_exists(referralBonus, :start) + :bonusAmount",
                        ExpressionAttributeValues: {
                            ":bonusAmount": { N: referralBonus.toString() },
                            ":start": { N: "0" }
                        } as Record<string, AttributeValue>
                    };

                    const bonusUpdateCommand = new UpdateItemCommand(bonusUpdateInput);
                    await dynamodb.send(bonusUpdateCommand);
                    console.log(`Bonus awarded to referrer: ${referrerUserSub}`);
                }
            } catch (recordError) {
                // Log individual record error but continue processing others in the batch
                console.error(`Error processing individual record in batch`, recordError);
            }
        }
        
        console.log("Batch processing complete.");

    } catch (error) {
        console.error("Fatal error processing batch:", error);
        // Throwing here triggers the Lambda Retry policy (which might re-process the whole batch)
        throw error; 
    }
};