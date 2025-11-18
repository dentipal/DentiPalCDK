"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    console.log("Received event:", JSON.stringify(event, null, 2));  // Log the full event

    try {
        if (!event || !event.Records) {
            console.log("No records found in event");
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No records in event" })
            };
        }

        for (const record of event.Records) {
            // Log each record for further debugging
            console.log("Processing record:", JSON.stringify(record, null, 2));

            // Only process MODIFY events where the status of the shift was updated
            if (record.eventName === 'MODIFY') {
                const newStatus = record.dynamodb.NewImage.applicationStatus.S;
                const jobId = record.dynamodb.Keys.jobId.S;
                const professionalUserSub = record.dynamodb.NewImage.professionalUserSub.S;

                console.log(`Processing Job ID: ${jobId} with status: ${newStatus}`);

                // 1. Check if the shift is marked as 'completed'
                if (newStatus !== 'completed') {
                    continue; // Skip if the status isn't completed
                }

                // 2. Query the referrals table to find the referrer
                const referralQueryCommand = new GetItemCommand({
                    TableName: process.env.REFERRALS_TABLE,
                    Key: { friendEmail: { S: professionalUserSub } }
                });

                const referralResult = await dynamodb.send(referralQueryCommand);
                console.log("Referral Result: ", referralResult);

                if (!referralResult.Item) {
                    continue; // If there's no referral record, skip
                }

                // 3. Get referrer's userSub and calculate the bonus
                const referrerUserSub = referralResult.Item.referrerUserSub.S;
                const referralBonus = 50; // Example bonus amount ($50)

                // 4. Update the referrer with the bonus in the REFERRALS_TABLE
                const bonusUpdateCommand = new UpdateItemCommand({
                    TableName: process.env.REFERRALS_TABLE,
                    Key: { referrerUserSub: { S: referrerUserSub } },
                    UpdateExpression: "SET referralBonus = if_not_exists(referralBonus, :start) + :bonusAmount",
                    ExpressionAttributeValues: {
                        ":bonusAmount": { N: referralBonus.toString() },
                        ":start": { N: "0" } // If no bonus exists, start from 0
                    }
                });

                await dynamodb.send(bonusUpdateCommand);
                console.log(`Bonus awarded to referrer: ${referrerUserSub}`);

                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: "Referral bonus awarded successfully." })
                };
            }
        }
    } catch (error) {
        console.error("Error processing bonus:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.handler = handler;
