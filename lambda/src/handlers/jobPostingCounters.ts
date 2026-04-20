import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

/**
 * Build the DynamoDB key for a job item, tolerating both schemas observed in
 * the codebase: single-PK (jobId only) and composite (clinicUserSub + jobId).
 * Pass the loaded job item — the helper picks the right shape.
 */
function buildJobKey(jobItem: Record<string, any>): Record<string, any> | null {
  const jobId = jobItem.jobId;
  if (!jobId) return null;
  const clinicUserSub = jobItem.clinicUserSub;
  if (clinicUserSub) return { clinicUserSub, jobId };
  return { jobId };
}

/**
 * Atomically bump the lifetime application counter on a job posting.
 * Used by the Mercor-style "Trending" sort to weight popular jobs.
 * The field is created on first write so no schema migration is needed.
 */
export async function incrementJobApplicationCount(
  jobItem: Record<string, any>
): Promise<void> {
  const Key = buildJobKey(jobItem);
  if (!Key) return;

  await ddbDoc.send(new UpdateCommand({
    TableName: JOB_POSTINGS_TABLE,
    Key,
    UpdateExpression: "ADD applicationsCount :one",
    ExpressionAttributeValues: { ":one": 1 },
  }));
}

/**
 * Non-blocking variant — never delays the user's create-application response.
 */
export function fireAndForgetJobApplicationIncrement(
  jobItem: Record<string, any>
): void {
  incrementJobApplicationCount(jobItem).catch((err) => {
    console.error(`Failed to increment applicationsCount for job ${jobItem?.jobId}:`, err);
  });
}
