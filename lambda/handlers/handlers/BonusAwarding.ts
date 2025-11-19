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

// Define a type for the structure of a single DynamoDB record for clarity and type safety
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

// Define the Lambda handler function with proper TypeScript types
export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
    console.log("Received event:", JSON.stringify(event, null, 2)); // Log the full event

    try {
        if (!event || !event.Records) {
            console.log("No records found in event");
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No records in event" })
            };
        }

        // Cast event.Records to the defined type for easier access, adjusting for the Lambda proxy return
        const records = event.Records as unknown as ReferralProcessingRecord[];

        for (const record of records) {
            // Log each record for further debugging
            console.log("Processing record:", JSON.stringify(record, null, 2));

            // Only process MODIFY events where the status of the shift was updated
            if (record.eventName === 'MODIFY' && record.dynamodb.NewImage) {
                // Ensure we have the necessary data points before proceeding
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

                // 1. Check if the shift is marked as 'completed'
                if (newStatus !== 'completed') {
                    continue; // Skip if the status isn't completed
                }

                // 2. Query the referrals table to find the referrer
                const referralQueryInput: GetItemCommandInput = {
                    TableName: process.env.REFERRALS_TABLE,
                    // Note: The Key seems to be querying on 'friendEmail', which holds the professionalUserSub
                    Key: { friendEmail: { S: professionalUserSub } } 
                };

                const referralQueryCommand = new GetItemCommand(referralQueryInput);
                const referralResult = await dynamodb.send(referralQueryCommand);
                console.log("Referral Result: ", referralResult);

                // Use the optional chaining on the Item to safely check for existence
                if (!referralResult.Item || !referralResult.Item.referrerUserSub?.S) {
                    console.log("No referral record or referrerUserSub found, skipping bonus award.");
                    continue; // If there's no referral record or referrer, skip
                }

                // 3. Get referrer's userSub and calculate the bonus
                const referrerUserSub: string = referralResult.Item.referrerUserSub.S;
                const referralBonus: number = 50; // Example bonus amount ($50)

                // 4. Update the referrer with the bonus in the REFERRALS_TABLE
                const bonusUpdateInput: UpdateItemCommandInput = {
                    TableName: process.env.REFERRALS_TABLE,
                    // The Key here assumes the primary key is 'referrerUserSub'
                    Key: { referrerUserSub: { S: referrerUserSub } }, 
                    UpdateExpression: "SET referralBonus = if_not_exists(referralBonus, :start) + :bonusAmount",
                    ExpressionAttributeValues: {
                        ":bonusAmount": { N: referralBonus.toString() },
                        ":start": { N: "0" } // If no bonus exists, start from 0
                    } as Record<string, AttributeValue>
                };

                const bonusUpdateCommand = new UpdateItemCommand(bonusUpdateInput);
                await dynamodb.send(bonusUpdateCommand);
                console.log(`Bonus awarded to referrer: ${referrerUserSub}`);

                // Returning here means the Lambda function execution finishes after the first successful update.
                // In a production scenario for a DynamoDB Stream, you usually process ALL records, 
                // but since the original JS code returns, we maintain that behavior strictly.
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: "Referral bonus awarded successfully." })
                };
            }
        }
        
        // Return a success message if the function completed without processing a 'completed' shift
        return {
            statusCode: 200,
            body: JSON.stringify({ message: "No relevant records processed." })
        };

    } catch (error) {
        // Ensure error is treated as a standard Error object for message property
        const err = error as Error; 
        console.error("Error processing bonus:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message })
        };
    }
};