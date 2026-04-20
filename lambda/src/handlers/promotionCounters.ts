import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

export type PromotionCounter = "impressions" | "clicks" | "applications";

export const PROMOTION_TIER_WEIGHT: Record<string, number> = {
  premium: 3,
  featured: 2,
  basic: 1,
};

export async function incrementPromotionCounter(
  jobId: string,
  promotionId: string,
  counter: PromotionCounter
): Promise<void> {
  await ddbDoc.send(new UpdateCommand({
    TableName: JOB_PROMOTIONS_TABLE,
    Key: { jobId, promotionId },
    UpdateExpression: "ADD #c :one",
    ExpressionAttributeNames: { "#c": counter },
    ExpressionAttributeValues: { ":one": 1 },
  }));
}

export function fireAndForgetIncrement(
  jobId: string,
  promotionId: string,
  counter: PromotionCounter
): void {
  incrementPromotionCounter(jobId, promotionId, counter).catch((err) => {
    console.error(`Failed to increment ${counter} for promotion ${promotionId}:`, err);
  });
}
