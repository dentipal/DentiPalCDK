import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandInput,
    UpdateItemCommand,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const dynamo = new DynamoDBClient({ region: REGION });

const REFERRALS_TABLE: string = process.env.REFERRALS_TABLE || "DentiPal-Referrals";
const PROFESSIONAL_PROFILES_TABLE: string =
    process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-ProfessionalProfiles";
const REFERRALS_REFERRED_USER_SUB_INDEX = "ReferredUserSubIndex";

export const REFERRAL_BONUS_AMOUNT = 50;

interface ReferralRecord {
    referralId: string;
    referrerUserSub: string;
    referredUserSub: string;
    status: string;
    [key: string]: any;
}

/**
 * Credit a referral bonus to the referrer when their referred professional completes
 * their first shift. Idempotent — the conditional update on `status = signed_up`
 * guarantees the bonus is paid at most once per referral.
 *
 * Returns true if a bonus was credited, false if there was nothing to do
 * (no referral on file, already paid, etc.).
 */
export const creditReferralBonusOnCompletion = async (
    professionalUserSub: string
): Promise<boolean> => {
    if (!professionalUserSub) return false;

    const referralQuery: QueryCommandInput = {
        TableName: REFERRALS_TABLE,
        IndexName: REFERRALS_REFERRED_USER_SUB_INDEX,
        KeyConditionExpression: "referredUserSub = :pSub",
        ExpressionAttributeValues: marshall({ ":pSub": professionalUserSub }) as Record<string, AttributeValue>,
    };

    let referralResult;
    try {
        referralResult = await dynamo.send(new QueryCommand(referralQuery));
    } catch (err) {
        console.error("[referralBonus] failed to query referrals", { professionalUserSub, error: (err as Error).message });
        return false;
    }

    if (!referralResult.Items || referralResult.Items.length === 0) return false;

    const referral = unmarshall(referralResult.Items[0]) as ReferralRecord;
    if (referral.status !== "signed_up") return false;

    const now = new Date().toISOString();

    try {
        await dynamo.send(new UpdateItemCommand({
            TableName: REFERRALS_TABLE,
            Key: marshall({ referralId: referral.referralId }) as Record<string, AttributeValue>,
            UpdateExpression: "SET #status = :bonusStatus, firstShiftCompletedAt = :now, updatedAt = :now",
            ConditionExpression: "#status = :signedUpStatus",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":bonusStatus": { S: "bonus_due" },
                ":signedUpStatus": { S: "signed_up" },
                ":now": { S: now },
            },
        }));
    } catch (err) {
        // ConditionalCheckFailedException = another request already credited the bonus.
        const name = (err as any)?.name;
        if (name === "ConditionalCheckFailedException") return false;
        console.error("[referralBonus] failed to flip referral to bonus_due", { referralId: referral.referralId, error: (err as Error).message });
        return false;
    }

    const bonusUpdate: UpdateItemCommandInput = {
        TableName: PROFESSIONAL_PROFILES_TABLE,
        Key: marshall({ userSub: referral.referrerUserSub }) as Record<string, AttributeValue>,
        UpdateExpression:
            "SET bonusBalance = if_not_exists(bonusBalance, :zero) + :amount, updatedAt = :now",
        ExpressionAttributeValues: {
            ":zero": { N: "0" },
            ":amount": { N: String(REFERRAL_BONUS_AMOUNT) },
            ":now": { S: now },
        },
    };

    try {
        await dynamo.send(new UpdateItemCommand(bonusUpdate));
    } catch (err) {
        console.error("[referralBonus] failed to credit referrer bonus", {
            referrerUserSub: referral.referrerUserSub,
            error: (err as Error).message,
        });
        // Don't try to roll back the referral status flip — the bonus_due state is
        // a payable record on its own; an oncall can reconcile if needed.
        return false;
    }

    return true;
};
