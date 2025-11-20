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
            return; // Simply return void
        }

        // Cast event.Records
        const records = event.Records as unknown as ReferralProcessingRecord[];

        // Loop through ALL records. 
        // CRITICAL CHANGE: We do not 'return' inside the loop, or we will skip the rest of the batch.
        for (const record of records) {
            
            // Wrap individual record processing in a try/catch so one bad record doesn't fail the whole batch
            try {
                console.log("Processing record:", JSON.stringify(record, null, 2));

                if (record.eventName === 'MODIFY' && record.dynamodb.NewImage) {
                    // Validation
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

                    // 1. Check status
                    if (newStatus !== 'completed') {
                        continue; 
                    }

                    // 2. Query Referrals Table
                    const referralQueryInput: GetItemCommandInput = {
                        TableName: process.env.REFERRALS_TABLE,
                        Key: { friendEmail: { S: professionalUserSub } }
                    };

                    const referralQueryCommand = new GetItemCommand(referralQueryInput);
                    const referralResult = await dynamodb.send(referralQueryCommand);

                    if (!referralResult.Item || !referralResult.Item.referrerUserSub?.S) {
                        console.log("No referral record found, skipping bonus award.");
                        continue;
                    }

                    // 3. Get referrer info
                    const referrerUserSub: string = referralResult.Item.referrerUserSub.S;
                    const referralBonus: number = 50; 

                    // 4. Update Bonus
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
                // Log individual record error but continue processing others
                console.error(`Error processing individual record in batch`, recordError);
            }
        }
        
        console.log("Batch processing complete.");
        return; // Return void

    } catch (error) {
        console.error("Fatal error processing batch:", error);
        // Optional: Throwing here triggers the Lambda Retry policy (which might re-process the whole batch)
        throw error; 
    }
};