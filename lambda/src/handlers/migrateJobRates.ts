/**
 * One-time migration script: Consolidates hourly_rate, rate_per_transaction,
 * revenue_percentage into a single `rate` column on JobPostings table.
 *
 * Run AFTER deploying the new code (read handlers have backward-compat fallbacks).
 *
 * Usage: invoke as a Lambda or run locally with AWS credentials.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

interface MigrationStats {
    scanned: number;
    migrated: number;
    skipped: number;
    errors: number;
}

export const handler = async (): Promise<{ statusCode: number; body: string }> => {
    const stats: MigrationStats = { scanned: 0, migrated: 0, skipped: 0, errors: 0 };
    let lastEvaluatedKey: Record<string, any> | undefined;

    console.log(`Starting migration on table: ${JOB_POSTINGS_TABLE}`);

    do {
        const scanResult = await ddbDoc.send(new ScanCommand({
            TableName: JOB_POSTINGS_TABLE,
            ExclusiveStartKey: lastEvaluatedKey,
        }));

        const items = scanResult.Items || [];
        lastEvaluatedKey = scanResult.LastEvaluatedKey;

        for (const item of items) {
            stats.scanned++;

            // Skip if already migrated (has `rate` column)
            if (item.rate !== undefined && item.rate !== null) {
                stats.skipped++;
                continue;
            }

            // Determine rate from legacy columns
            const payType = item.pay_type || "per_hour";
            let rate: number | null = null;

            if (payType === "per_transaction" && item.rate_per_transaction != null) {
                rate = Number(item.rate_per_transaction);
            } else if (payType === "percentage_of_revenue" && item.revenue_percentage != null) {
                rate = Number(item.revenue_percentage);
            } else if (item.hourly_rate != null) {
                rate = Number(item.hourly_rate);
            }

            // Skip if no legacy rate data exists (e.g., permanent jobs using salary_min/salary_max)
            if (rate === null || isNaN(rate)) {
                stats.skipped++;
                continue;
            }

            try {
                await ddbDoc.send(new UpdateCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    Key: {
                        clinicUserSub: item.clinicUserSub,
                        jobId: item.jobId,
                    },
                    UpdateExpression: "SET #rate = :rate, #pt = :pt REMOVE #hr, #rpt, #rp",
                    ExpressionAttributeNames: {
                        "#rate": "rate",
                        "#pt": "pay_type",
                        "#hr": "hourly_rate",
                        "#rpt": "rate_per_transaction",
                        "#rp": "revenue_percentage",
                    },
                    ExpressionAttributeValues: {
                        ":rate": rate,
                        ":pt": payType,
                    },
                }));
                stats.migrated++;
                if (stats.migrated % 50 === 0) {
                    console.log(`Progress: ${stats.migrated} migrated, ${stats.scanned} scanned`);
                }
            } catch (err: any) {
                stats.errors++;
                console.error(`Failed to migrate item ${item.jobId}:`, err.message);
            }
        }
    } while (lastEvaluatedKey);

    const summary = `Migration complete. Scanned: ${stats.scanned}, Migrated: ${stats.migrated}, Skipped: ${stats.skipped}, Errors: ${stats.errors}`;
    console.log(summary);

    return {
        statusCode: 200,
        body: JSON.stringify({ message: summary, stats }),
    };
};
