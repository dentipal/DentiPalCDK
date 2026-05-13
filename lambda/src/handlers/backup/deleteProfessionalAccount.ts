import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient, GetCommand, QueryCommand, DeleteCommand, BatchWriteCommand, PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
    S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} from "@aws-sdk/client-s3";
import {
    CognitoIdentityProviderClient, AdminDeleteUserCommand, AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

const TIER1_FIELDS = [
    "userSub", "first_name", "last_name", "role", "professional_role",
    "yearsOfExperience", "bio", "specialties", "dentalSoftwareExperience",
    "is_willing_to_travel", "max_travel_distance", "city", "state",
    "profileImageKey", "createdAt", "updatedAt",
    "savedJobs", "referralCode", "referralStatus",
];

const TIER2_FIELDS = [
    "email", "phone", "addressLine1", "addressLine2", "zipcode", "country",
    "skills", "qualifications", "certificates", "license_number", "degree",
    "dental_hygiene_degree", "availability", "payTypePreference",
    "clinical_experience_hygienist", "lastSearchFilters", "shiftSpeciality",
];

const FILE_FIELDS: Array<{ field: string; bucketEnv: string }> = [
    { field: "profileImageKey", bucketEnv: "PROFILE_IMAGES_BUCKET" },
    { field: "resumeKey", bucketEnv: "PROFESSIONAL_RESUMES_BUCKET" },
    { field: "driversLicenseKey", bucketEnv: "DRIVING_LICENSES_BUCKET" },
    { field: "professionalLicenseKey", bucketEnv: "PROFESSIONAL_LICENSES_BUCKET" },
    { field: "introVideoKey", bucketEnv: "VIDEO_RESUMES_BUCKET" },
];

const pick = (obj: any, fields: string[]) =>
    Object.fromEntries(fields.filter(f => obj[f] !== undefined).map(f => [f, obj[f]]));

const copyToBackup = async (sourceBucket: string, sourceKey: string, destKey: string) => {
    try {
        await s3.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: sourceKey }));
        await s3.send(new CopyObjectCommand({
            Bucket: process.env.BACKUP_BUCKET!,
            CopySource: encodeURIComponent(`${sourceBucket}/${sourceKey}`),
            Key: destKey,
            ServerSideEncryption: "AES256",
        }));
        return true;
    } catch {
        return false;
    }
};

const deleteFromSource = async (bucket: string, key: string) => {
    try {
        await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        return true;
    } catch {
        return false;
    }
};

const queryByGsi = async (
    table: string, indexName: string, pkName: string, pkValue: string,
): Promise<any[]> => {
    const items: any[] = [];
    let lastKey: any = undefined;
    do {
        const r = await ddb.send(new QueryCommand({
            TableName: table,
            IndexName: indexName,
            KeyConditionExpression: "#pk = :v",
            ExpressionAttributeNames: { "#pk": pkName },
            ExpressionAttributeValues: { ":v": pkValue },
            ExclusiveStartKey: lastKey,
        }));
        items.push(...(r.Items ?? []));
        lastKey = r.LastEvaluatedKey;
    } while (lastKey);
    return items;
};

const queryByPk = async (table: string, pkName: string, pkValue: string): Promise<any[]> => {
    const items: any[] = [];
    let lastKey: any = undefined;
    do {
        const r = await ddb.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: "#pk = :v",
            ExpressionAttributeNames: { "#pk": pkName },
            ExpressionAttributeValues: { ":v": pkValue },
            ExclusiveStartKey: lastKey,
        }));
        items.push(...(r.Items ?? []));
        lastKey = r.LastEvaluatedKey;
    } while (lastKey);
    return items;
};

const batchDelete = async (table: string, keys: Record<string, any>[]) => {
    for (let i = 0; i < keys.length; i += 25) {
        const batch = keys.slice(i, i + 25);
        await ddb.send(new BatchWriteCommand({
            RequestItems: {
                [table]: batch.map(Key => ({ DeleteRequest: { Key } })),
            },
        }));
    }
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    // 1. Authenticate
    let userSub: string;
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const info = extractUserFromBearerToken(authHeader);
        userSub = info.sub;
    } catch (err: any) {
        return json(event, 401, { error: "Unauthorized", message: err.message || "Invalid token" });
    }

    const startedAt = new Date().toISOString();
    const snapshotId = `delete-${startedAt}`;
    const summary: any = {
        userSub, snapshotId, startedAt,
        tables: {} as Record<string, { deleted: number }>,
        files: { backed_up: 0, deleted: 0, failed: 0 },
        cognito: { deleted: false },
    };

    try {
        // 2. Fetch professional profile
        const profileRes = await ddb.send(new GetCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE!,
            Key: { userSub },
        }));
        const profile = profileRes.Item;

        if (!profile) {
            return json(event, 404, { error: "Not Found", message: "Professional profile not found" });
        }

        // 3. Gather related rows BEFORE deleting
        //    NOTE: UserClinicAssignments is a CLINIC-side table (clinic staff
        //    membership), so it's NOT included here — professionals never
        //    have rows in that table.
        const [userAddresses, jobInvitations, referrals] = await Promise.all([
            queryByPk(process.env.USER_ADDRESSES_TABLE!, "userSub", userSub).catch(() => []),
            queryByGsi(process.env.JOB_INVITATIONS_TABLE!, "ProfessionalIndex", "professionalUserSub", userSub).catch(() => []),
            queryByPk(process.env.REFERRALS_TABLE!, "userSub", userSub).catch(() => []),
        ]);

        // 4. Copy all uploaded files to the backup bucket
        const fileRefs: Record<string, any> = {};
        for (const { field, bucketEnv } of FILE_FIELDS) {
            const key = profile[field];
            if (!key) continue;
            const bucket = process.env[bucketEnv];
            if (!bucket) continue;
            const destKey = `deletions/${userSub}/${snapshotId}/files/${field}`;
            const ok = await copyToBackup(bucket, key, destKey);
            fileRefs[field] = { sourceBucket: bucket, sourceKey: key, backupKey: destKey, copied: ok };
            ok ? summary.files.backed_up++ : summary.files.failed++;
        }

        // 5. BACKUP — write the single all-in-one snapshot row
        await ddb.send(new PutCommand({
            TableName: process.env.PROFESSIONAL_BACKUP_TABLE!,
            Item: {
                userSub,
                snapshotId,
                snapshotType: "delete",
                createdAt: startedAt,
                tier1: pick(profile, TIER1_FIELDS),
                tier2: pick(profile, TIER2_FIELDS),
                userAddresses,
                jobInvitations,
                referrals,
                files: fileRefs,
            },
        }));

        // =========================================================
        // PURGE STAGE — snapshot row is durable, now remove user data
        // =========================================================

        // 6. Delete source S3 files
        for (const { field, bucketEnv } of FILE_FIELDS) {
            const key = profile[field];
            if (!key) continue;
            const bucket = process.env[bucketEnv];
            if (!bucket) continue;
            if (await deleteFromSource(bucket, key)) summary.files.deleted++;
        }

        // 7. Delete DynamoDB rows from live tables
        await ddb.send(new DeleteCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE!,
            Key: { userSub },
        }));
        summary.tables.professionalProfiles = { deleted: 1 };

        await batchDelete(
            process.env.USER_ADDRESSES_TABLE!,
            userAddresses.map(a => ({ userSub: a.userSub, addressId: a.addressId })),
        );
        summary.tables.userAddresses = { deleted: userAddresses.length };

        await batchDelete(
            process.env.JOB_INVITATIONS_TABLE!,
            jobInvitations.map(j => ({ jobId: j.jobId, professionalUserSub: j.professionalUserSub })),
        );
        summary.tables.jobInvitations = { deleted: jobInvitations.length };

        try {
            await ddb.send(new DeleteCommand({
                TableName: process.env.BANS_TABLE!,
                Key: { subjectType: "professional", subjectId: userSub },
            }));
            summary.tables.bans = { deleted: 1 };
        } catch { /* item may not exist */ }

        // 8. Delete from Cognito
        try {
            await cognito.send(new AdminGetUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: userSub,
            }));
            await cognito.send(new AdminDeleteUserCommand({
                UserPoolId: process.env.USER_POOL_ID!,
                Username: userSub,
            }));
            summary.cognito.deleted = true;
        } catch (err: any) {
            summary.cognito.error = err.name || String(err);
        }

        summary.completedAt = new Date().toISOString();

        return json(event, 200, {
            status: "success",
            message: "Professional account backed up to ProfessionalBackup table and deleted",
            data: summary,
        });

    } catch (err: any) {
        console.error("delete-professional-account failed", err);
        summary.error = err.message || String(err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: "Failed to delete professional account",
            details: { reason: err.message, partialSummary: summary },
        });
    }
};
