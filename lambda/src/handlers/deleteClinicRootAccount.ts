import {
    DynamoDBClient,
    QueryCommand,
    ScanCommand,
    GetItemCommand,
    PutItemCommand,
    DeleteItemCommand,
    UpdateItemCommand,
    BatchWriteItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AdminListGroupsForUserCommand,
    AdminUserGlobalSignOutCommand,
    AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
    S3Client,
    CopyObjectCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
} from "@aws-sdk/client-s3";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot } from "./utils";
import { corsHeaders } from "./corsHeaders";

// ─────────────────────────────────────────────────────────────────────────────
// POST /clinic-root-account/delete
//
// User-initiated permanent account deletion for the Root user on the clinic
// side. Only callers in the Root Cognito group can use this — the name says
// what it does. Every clinic the Root owns, every associated piece of
// clinic-scoped data, and the Cognito user itself are purged, AFTER a frozen
// backup is captured for compliance. Flow:
//
//   1. Validate the confirmation modal payload (reason ≥ 20, confirmText
//      exactly "delete my account").
//   2. Pre-flight blocks:
//        - Owner is the platform's last Root user → 409 (must grant another
//          user Root first).
//   3. Build the backup row in memory:
//        - Cognito snapshot via AdminGetUser + AdminListGroupsForUser.
//        - All owned clinics, profiles, members, ratings received.
//        - accountSummary rollup (clinics / earnings / posted / completed).
//        - completedJobs[] + completedApplications[] (audit trail).
//        - Copy every owner-owned media file to the backup bucket and
//          record it in mediaIndex.
//   4. PutItem the backup row, then GetItem to verify it landed. If
//      verification fails, abort — never enter the purge phase without a
//      confirmed backup.
//   5. Purge live data in safe child-first order. Leaves the Cognito user
//      itself for the very last step.
//   6. AdminUserGlobalSignOut + AdminDeleteUser.
//   7. Return 200 with the backup pointer.
// ─────────────────────────────────────────────────────────────────────────────

const REGION = process.env.REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

// Tables (all already present in process.env on the monolith Lambda)
const CLINICS_TABLE = process.env.CLINICS_TABLE!;
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "";
const USER_CLINIC_ASSIGNMENTS_TABLE = process.env.USER_CLINIC_ASSIGNMENTS_TABLE || "";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "";
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE || "";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "";
// Note: ratings received about a clinic live in CLINIC_RATINGS_TABLE
// (DentiPal-V5-ClinicRatings, keyed clinicId+professionalJobKey).
// The FEEDBACK_TABLE is "Send Feedback" submissions, not clinic ratings.
const CLINIC_RATINGS_TABLE = process.env.CLINIC_RATINGS_TABLE || "";
const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || "";
const CLINIC_ACCOUNT_BACKUP_TABLE = "DentiPal-V5-ClinicAccountBackup";

// Buckets
const PROFILE_IMAGES_BUCKET = process.env.PROFILE_IMAGES_BUCKET || "";
const CLINIC_OFFICE_IMAGES_BUCKET = process.env.CLINIC_OFFICE_IMAGES_BUCKET || "";
const CLINIC_ACCOUNT_BACKUP_BUCKET = process.env.CLINIC_ACCOUNT_BACKUP_BUCKET || "";

const USER_POOL_ID = process.env.USER_POOL_ID!;

const MIN_REASON_LENGTH = 20;
const REQUIRED_CONFIRM_TEXT = "DELETE MY ACCOUNT";
const CLINIC_ID_INDEX = "ClinicIdIndex";

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// Helpers ────────────────────────────────────────────────────────────────────

const s = (img: Record<string, AttributeValue> | undefined, key: string): string | undefined =>
    img?.[key]?.S;

const unmarshallShallow = (item: Record<string, AttributeValue>): Record<string, any> => {
    // Lightweight unmarshall — only covers S / N / BOOL / NULL / L of S / SS / M of S.
    // Sufficient for the JSON blobs we embed in the backup row. The backup is
    // a frozen historical record; lossy unmarshalling of exotic shapes is fine.
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
        if (v.S !== undefined) out[k] = v.S;
        else if (v.N !== undefined) out[k] = Number(v.N);
        else if (v.BOOL !== undefined) out[k] = v.BOOL;
        else if (v.NULL) out[k] = null;
        else if (v.SS) out[k] = v.SS;
        else if (v.NS) out[k] = (v.NS || []).map(n => Number(n));
        else if (v.L) out[k] = v.L.map(x => x.S ?? x.N ?? x.BOOL ?? null);
        else if (v.M) {
            const inner: Record<string, any> = {};
            for (const [mk, mv] of Object.entries(v.M)) {
                inner[mk] = mv.S ?? (mv.N !== undefined ? Number(mv.N) : mv.BOOL);
            }
            out[k] = inner;
        }
    }
    return out;
};

const queryAllByPK = async (
    tableName: string,
    pkName: string,
    pkValue: string,
    indexName?: string
): Promise<Record<string, AttributeValue>[]> => {
    const items: Record<string, AttributeValue>[] = [];
    let exclusiveStart: Record<string, AttributeValue> | undefined;
    do {
        const out = await ddb.send(new QueryCommand({
            TableName: tableName,
            IndexName: indexName,
            KeyConditionExpression: `${pkName} = :v`,
            ExpressionAttributeValues: { ":v": { S: pkValue } },
            ExclusiveStartKey: exclusiveStart,
        }));
        for (const it of out.Items || []) items.push(it);
        exclusiveStart = out.LastEvaluatedKey;
    } while (exclusiveStart);
    return items;
};

const scanByFilter = async (
    tableName: string,
    expr: string,
    values: Record<string, AttributeValue>
): Promise<Record<string, AttributeValue>[]> => {
    const items: Record<string, AttributeValue>[] = [];
    let exclusiveStart: Record<string, AttributeValue> | undefined;
    do {
        const out = await ddb.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: expr,
            ExpressionAttributeValues: values,
            ExclusiveStartKey: exclusiveStart,
        }));
        for (const it of out.Items || []) items.push(it);
        exclusiveStart = out.LastEvaluatedKey;
    } while (exclusiveStart);
    return items;
};

// Batch-delete with UnprocessedItems retry loop. Caller passes
// { TableName, Key } pairs; we group by table and chunk per-table.
//
// Isolation strategy: each table is batched separately. If one table has a
// key-schema mismatch, only THAT table's batch throws — so the catch block
// reports the exact TableName and the key shapes that were rejected, rather
// than burying the bug in a generic "schema mismatch" error from a mixed
// batch. Non-fatal: a single table failing does NOT abort the whole purge —
// other tables continue and we collect the failure list at the end.
type DeleteKey = { TableName: string; Key: Record<string, AttributeValue> };
type FailedBatch = { TableName: string; sampleKey: Record<string, AttributeValue>; error: string };

const sendBatchDeletes = async (deletes: DeleteKey[]): Promise<FailedBatch[]> => {
    const failures: FailedBatch[] = [];
    if (deletes.length === 0) return failures;

    // Group by TableName first.
    const byTable: Record<string, Record<string, AttributeValue>[]> = {};
    for (const d of deletes) {
        (byTable[d.TableName] ||= []).push(d.Key);
    }

    for (const [tableName, keys] of Object.entries(byTable)) {
        console.log(`[deleteClinicRootAccount] batch-delete table=${tableName} count=${keys.length}`);
        if (keys.length > 0) {
            console.log(`[deleteClinicRootAccount] sample key for ${tableName}:`, JSON.stringify(keys[0]));
        }
        const CHUNK = 25;
        for (let i = 0; i < keys.length; i += CHUNK) {
            const chunk = keys.slice(i, i + CHUNK);
            const RequestItems = {
                [tableName]: chunk.map(Key => ({ DeleteRequest: { Key } })),
            };
            let unprocessed = RequestItems;
            try {
                for (let attempt = 0; attempt < 5; attempt++) {
                    const resp = await ddb.send(new BatchWriteItemCommand({ RequestItems: unprocessed }));
                    const left = resp.UnprocessedItems || {};
                    if (Object.keys(left).length === 0) break;
                    await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
                    unprocessed = left as any;
                    if (attempt === 4) {
                        console.error(`[deleteClinicRootAccount] UnprocessedItems remain after 5 retries for ${tableName}`, { left });
                    }
                }
            } catch (err) {
                const msg = (err as Error).message;
                console.error(`[deleteClinicRootAccount] batch FAILED for table=${tableName}:`, msg, "sample key:", JSON.stringify(chunk[0]));
                failures.push({ TableName: tableName, sampleKey: chunk[0], error: msg });
                // Skip remaining chunks for this table — they'll fail the same way.
                break;
            }
        }
    }
    return failures;
};

// S3 helpers ─────────────────────────────────────────────────────────────────

interface MediaEntry {
    domain: string;
    sourceBucket: string;
    sourceKey: string;
    backupKey: string;
    contentType?: string;
    sizeBytes?: number;
    copiedAt: string;
}

const copyPrefixToBackup = async (
    sourceBucket: string,
    sourcePrefix: string,
    backupPrefix: string,
    domain: string,
    out: MediaEntry[]
) => {
    if (!sourceBucket || !CLINIC_ACCOUNT_BACKUP_BUCKET) return;
    let ContinuationToken: string | undefined;
    do {
        const list = await s3.send(new ListObjectsV2Command({
            Bucket: sourceBucket,
            Prefix: sourcePrefix,
            ContinuationToken,
        }));
        for (const obj of list.Contents || []) {
            if (!obj.Key) continue;
            const relativeKey = obj.Key.startsWith(sourcePrefix) ? obj.Key.slice(sourcePrefix.length) : obj.Key;
            const backupKey = `${backupPrefix}${relativeKey}`;
            await s3.send(new CopyObjectCommand({
                Bucket: CLINIC_ACCOUNT_BACKUP_BUCKET,
                Key: backupKey,
                CopySource: encodeURIComponent(`${sourceBucket}/${obj.Key}`),
            }));
            // HeadObject so the mediaIndex carries content-type + size of the copy.
            let contentType: string | undefined;
            try {
                const head = await s3.send(new HeadObjectCommand({
                    Bucket: CLINIC_ACCOUNT_BACKUP_BUCKET,
                    Key: backupKey,
                }));
                contentType = head.ContentType;
            } catch { /* best-effort */ }
            out.push({
                domain,
                sourceBucket,
                sourceKey: obj.Key,
                backupKey,
                contentType,
                sizeBytes: obj.Size,
                copiedAt: new Date().toISOString(),
            });
        }
        ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);
};

const deletePrefix = async (bucket: string, prefix: string) => {
    if (!bucket) return;
    let ContinuationToken: string | undefined;
    do {
        const list = await s3.send(new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken,
        }));
        const keys = (list.Contents || []).map(o => ({ Key: o.Key! })).filter(o => o.Key);
        if (keys.length > 0) {
            await s3.send(new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: keys, Quiet: true },
            }));
        }
        ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (ContinuationToken);
};

// Pre-flight ─────────────────────────────────────────────────────────────────

const isLastPlatformRoot = async (ownerSub: string, groups: string[]): Promise<boolean> => {
    // Only matters if this user is themselves Root. Non-Root users can never
    // be "the last Root."
    if (!isRoot(groups)) return false;
    try {
        // ListUsersInGroup paginates. For this guard we just want to know
        // whether there's ANY other Root user. Conservative: if anything goes
        // wrong, treat as "yes, you're the last Root" so we don't accidentally
        // lock the platform out.
        const { CognitoIdentityProviderClient: C, ListUsersInGroupCommand } =
            await import("@aws-sdk/client-cognito-identity-provider");
        const client = new C({ region: REGION });
        let NextToken: string | undefined;
        let othersFound = false;
        do {
            const resp = await client.send(new ListUsersInGroupCommand({
                UserPoolId: USER_POOL_ID,
                GroupName: "Root",
                NextToken,
            }));
            for (const u of resp.Users || []) {
                const sub = (u.Attributes || []).find(a => a.Name === "sub")?.Value;
                if (sub && sub !== ownerSub) {
                    othersFound = true;
                    break;
                }
            }
            if (othersFound) break;
            NextToken = resp.NextToken;
        } while (NextToken);
        return !othersFound;
    } catch (err) {
        console.warn("[deleteClinicRootAccount] last-Root check failed; assuming last:", (err as Error).message);
        return true;
    }
};

// Cognito snapshot ───────────────────────────────────────────────────────────

const fetchCognitoIdentity = async (ownerSub: string): Promise<Record<string, any>> => {
    // AdminGetUser accepts Username = sub for Cognito pools that use sub as username
    // (which DentiPal does — see token claims). Also tolerates email-username pools.
    const u = await cognito.send(new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: ownerSub,
    }));
    const attributes: Record<string, string> = {};
    for (const a of u.UserAttributes || []) {
        if (a.Name && a.Value !== undefined) attributes[a.Name] = a.Value;
    }
    const g = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: ownerSub,
    }));
    const groups = (g.Groups || []).map(x => x.GroupName).filter((x): x is string => !!x);

    return {
        userPoolId: USER_POOL_ID,
        username: u.Username,
        sub: attributes.sub || ownerSub,
        email: attributes.email,
        emailVerified: attributes.email_verified === "true",
        phoneNumber: attributes.phone_number,
        phoneNumberVerified: attributes.phone_number_verified === "true",
        status: u.UserStatus,
        enabled: u.Enabled,
        createdAt: u.UserCreateDate?.toISOString?.(),
        lastModifiedAt: u.UserLastModifiedDate?.toISOString?.(),
        groups,
        attributes,
        identities: attributes.identities ? safeParseJson(attributes.identities) : [],
    };
};

const safeParseJson = (v: string): any => { try { return JSON.parse(v); } catch { return v; } };

const buildUserProfile = (cognitoIdentity: Record<string, any>): Record<string, any> => {
    const a = (cognitoIdentity.attributes || {}) as Record<string, string>;
    const firstName = a.given_name || "";
    const lastName = a.family_name || "";
    return {
        ownerSub: cognitoIdentity.sub,
        email: (cognitoIdentity.email || "").toLowerCase(),
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`.trim(),
        phoneNumber: cognitoIdentity.phoneNumber || null,
        userType: a["custom:user_type"] || "clinic",
        primaryClinicRole: (cognitoIdentity.groups || [])[0]?.toLowerCase() || null,
        cognitoGroups: cognitoIdentity.groups || [],
        title: a.title || null,
        profileImageKey: a["custom:profile_image_key"] || null,
        address: a.address || null,
        emailVerified: cognitoIdentity.emailVerified,
        phoneVerified: cognitoIdentity.phoneNumberVerified,
        status: cognitoIdentity.status,
        createdAt: cognitoIdentity.createdAt,
        lastModifiedAt: cognitoIdentity.lastModifiedAt,
        rawExtras: a,
    };
};

// Account summary rollup ─────────────────────────────────────────────────────

const buildAccountSummary = (
    ownedClinics: Record<string, AttributeValue>[],
    allJobs: Record<string, AttributeValue>[],
    completedApps: Record<string, any>[],
) => {
    const completed = allJobs.filter(j => (j.status?.S || "").toLowerCase() === "completed");
    const cancelled = allJobs.filter(j => (j.status?.S || "").toLowerCase() === "cancelled");
    const pending = allJobs.filter(j => {
        const st = (j.status?.S || "active").toLowerCase();
        return st !== "completed" && st !== "cancelled";
    });

    // Earnings = sum(rate × hours) over completed applications, bucketed by month.
    const monthlyMap = new Map<string, number>();
    let lifetime = 0;
    for (const app of completedApps) {
        const rate = Number(app.hourlyRate ?? app.rate ?? 0);
        const hours = Number(app.totalHours ?? app.hours ?? 0);
        const earned = rate * hours;
        lifetime += earned;
        const when = app.completedAt || app.updatedAt || app.createdAt;
        if (typeof when === "string" && when.length >= 7) {
            const month = when.slice(0, 7); // YYYY-MM
            monthlyMap.set(month, (monthlyMap.get(month) || 0) + earned);
        }
    }
    const monthlyBreakdown = Array.from(monthlyMap.entries())
        .map(([month, total]) => ({ month, total: Number(total.toFixed(2)) }))
        .sort((a, b) => a.month.localeCompare(b.month));

    const nowMonth = new Date().toISOString().slice(0, 7);
    const nowYear = nowMonth.slice(0, 4);
    const currentMonth = monthlyBreakdown.find(m => m.month === nowMonth)?.total ?? 0;
    const currentYear = monthlyBreakdown
        .filter(m => m.month.startsWith(nowYear))
        .reduce((acc, m) => acc + m.total, 0);

    return {
        asOf: new Date().toISOString(),
        clinics: {
            active: ownedClinics.filter(c => !c.deletedAt?.S).length,
            total: ownedClinics.length,
        },
        earnings: {
            currentMonth: Number(currentMonth.toFixed(2)),
            currentYear: Number(currentYear.toFixed(2)),
            lifetime: Number(lifetime.toFixed(2)),
            monthlyBreakdown,
        },
        jobs: {
            posted: allJobs.length,
            completed: completed.length,
            cancelled: cancelled.length,
            pending: pending.length,
        },
    };
};

// Handler ────────────────────────────────────────────────────────────────────

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";
    if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };

    try {
        // 1) Authn — Root-only. The endpoint is literally "Delete Clinic Root
        //    Account"; non-Root callers can't trigger this even on their own
        //    account. (Non-Root clinic users would use a remove-from-clinic
        //    flow, which is a different feature.)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const ownerSub = userInfo.sub;
        const groups = userInfo.groups || [];

        if (!isRoot(groups)) {
            return json(event, 403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root users can delete a clinic root account.",
            });
        }

        // 2) Parse + validate body
        let body: { reason?: string; confirmText?: string } = {};
        try { body = event.body ? JSON.parse(event.body) : {}; }
        catch { return json(event, 400, { error: "Bad Request", message: "Invalid JSON body." }); }

        const reason = (body.reason || "").trim();
        const confirmText = (body.confirmText || "").trim();

        if (confirmText !== REQUIRED_CONFIRM_TEXT) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: `You must type "${REQUIRED_CONFIRM_TEXT}" to confirm account deletion.`,
                details: { field: "confirmText" },
            });
        }
        if (reason.length < MIN_REASON_LENGTH) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: `A reason of at least ${MIN_REASON_LENGTH} characters is required.`,
                details: { field: "reason", minLength: MIN_REASON_LENGTH },
            });
        }

        // 3) Pre-flight: not the last Root
        if (await isLastPlatformRoot(ownerSub, groups)) {
            return json(event, 409, {
                error: "Conflict",
                statusCode: 409,
                message: "You are the only Root user on the platform. Grant another user the Root role before deleting your account.",
            });
        }

        const deletedAt = new Date().toISOString();

        // 4) Build the backup
        const cognitoIdentity = await fetchCognitoIdentity(ownerSub);
        const userProfile = buildUserProfile(cognitoIdentity);

        // Owned clinics + per-clinic profile + members + ratings.
        const ownedClinicsRaw = await scanByFilter(
            CLINICS_TABLE,
            "createdBy = :sub",
            { ":sub": { S: ownerSub } }
        );
        const ownedClinicIds = ownedClinicsRaw.map(c => c.clinicId?.S).filter((x): x is string => !!x);

        const clinicProfilesRaw: Record<string, AttributeValue>[] = [];
        const membersRaw: Record<string, AttributeValue>[] = [];
        const ratingsReceivedRaw: Record<string, AttributeValue>[] = [];
        const allJobsRaw: Record<string, AttributeValue>[] = [];
        const allAppsRaw: Record<string, AttributeValue>[] = [];
        const invitationsRaw: Record<string, AttributeValue>[] = [];
        const negotiationsRaw: Record<string, AttributeValue>[] = [];

        for (const cid of ownedClinicIds) {
            // ClinicProfiles is keyed (clinicId PK, userSub SK). Query by PK.
            if (CLINIC_PROFILES_TABLE) {
                try {
                    const ps = await queryAllByPK(CLINIC_PROFILES_TABLE, "clinicId", cid);
                    clinicProfilesRaw.push(...ps);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] profile query failed for ${cid}:`, (err as Error).message);
                }
            }
            // UserClinicAssignments is keyed (userSub PK, clinicId SK) and has
            // no GSI on clinicId. Scan with a filter is the only option.
            if (USER_CLINIC_ASSIGNMENTS_TABLE) {
                try {
                    const ms = await scanByFilter(
                        USER_CLINIC_ASSIGNMENTS_TABLE,
                        "clinicId = :cid",
                        { ":cid": { S: cid } },
                    );
                    membersRaw.push(...ms);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] members scan failed for ${cid}:`, (err as Error).message);
                }
            }
            if (JOB_POSTINGS_TABLE) {
                try {
                    const js = await queryAllByPK(JOB_POSTINGS_TABLE, "clinicId", cid, CLINIC_ID_INDEX);
                    allJobsRaw.push(...js);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] jobs query failed for ${cid}:`, (err as Error).message);
                }
            }
        }

        // For each job: applications, invitations, negotiations.
        // JobApplications is keyed (jobId PK, professionalUserSub SK) — Query by PK.
        // JobInvitations is keyed (jobId PK, professionalUserSub SK) — Query by PK.
        for (const job of allJobsRaw) {
            const jobId = job.jobId?.S;
            if (!jobId) continue;
            if (JOB_APPLICATIONS_TABLE) {
                try {
                    const apps = await queryAllByPK(JOB_APPLICATIONS_TABLE, "jobId", jobId);
                    allAppsRaw.push(...apps);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] applications query failed for job ${jobId}:`, (err as Error).message);
                }
            }
            if (JOB_INVITATIONS_TABLE) {
                try {
                    const invs = await queryAllByPK(JOB_INVITATIONS_TABLE, "jobId", jobId);
                    invitationsRaw.push(...invs);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] invitations query failed for job ${jobId}:`, (err as Error).message);
                }
            }
        }
        // JobNegotiations is keyed (applicationId PK, negotiationId SK). The
        // JobApplications schema has no `applicationId` column — applications
        // are identified by (jobId, professionalUserSub). If your negotiations
        // refer to applications by a different key, the synthesized id is
        // "{jobId}#{professionalUserSub}". Try that.
        for (const app of allAppsRaw) {
            const jobId = app.jobId?.S;
            const profSub = app.professionalUserSub?.S;
            if (!jobId || !profSub) continue;
            const candidateAppIds = [
                app.applicationId?.S,
                `${jobId}#${profSub}`,
            ].filter((x): x is string => !!x);
            for (const appId of candidateAppIds) {
                if (JOB_NEGOTIATIONS_TABLE) {
                    try {
                        const negs = await queryAllByPK(JOB_NEGOTIATIONS_TABLE, "applicationId", appId);
                        negotiationsRaw.push(...negs);
                    } catch (err) {
                        console.warn(`[deleteClinicRootAccount] negotiations query failed for ${appId}:`, (err as Error).message);
                    }
                }
            }
        }

        // Ratings received about each owned clinic. ClinicRatings is keyed
        // (clinicId PK, professionalJobKey SK) — Query by PK is cheap and
        // returns every rating that clinic has received.
        if (CLINIC_RATINGS_TABLE) {
            for (const cid of ownedClinicIds) {
                try {
                    const rs = await queryAllByPK(CLINIC_RATINGS_TABLE, "clinicId", cid);
                    ratingsReceivedRaw.push(...rs);
                } catch (err) {
                    console.warn(`[deleteClinicRootAccount] ratings query failed for ${cid}:`, (err as Error).message);
                }
            }
        }

        // completedJobs[] + completedApplications[] (audit trail under accountSummary).
        const completedJobs = allJobsRaw
            .filter(j => (j.status?.S || "").toLowerCase() === "completed")
            .map(unmarshallShallow);
        const completedApplications = allAppsRaw
            .filter(a => (a.applicationStatus?.S || a.status?.S || "").toLowerCase() === "completed")
            .map(unmarshallShallow);

        const accountSummary = buildAccountSummary(ownedClinicsRaw, allJobsRaw, completedApplications);

        // 5) Copy media to backup bucket. Profile image (under sub) + per-clinic office images.
        const mediaIndex: MediaEntry[] = [];
        const backupBasePrefix = `${ownerSub}/${deletedAt}/`;
        if (PROFILE_IMAGES_BUCKET) {
            await copyPrefixToBackup(
                PROFILE_IMAGES_BUCKET,
                `${ownerSub}/`,
                `${backupBasePrefix}profile-images/`,
                "userProfile",
                mediaIndex,
            );
        }
        if (CLINIC_OFFICE_IMAGES_BUCKET) {
            for (const cid of ownedClinicIds) {
                await copyPrefixToBackup(
                    CLINIC_OFFICE_IMAGES_BUCKET,
                    `clinic-office-image/${cid}/`,
                    `${backupBasePrefix}clinic-office-image/${cid}/`,
                    `clinic:${cid}`,
                    mediaIndex,
                );
            }
        }

        // 6) Build + write the backup row, then verify.
        const backupItem: Record<string, AttributeValue> = {
            ownerSub: { S: ownerSub },
            deletedAt: { S: deletedAt },
            ownerEmail: { S: (cognitoIdentity.email || "").toLowerCase() },
            deletedBy: { S: ownerSub },
            reason: { S: reason },
            confirmText: { S: confirmText },
            cognitoIdentity: { S: JSON.stringify(cognitoIdentity) },
            userProfile: { S: JSON.stringify(userProfile) },
            clinics: { S: JSON.stringify(ownedClinicsRaw.map(unmarshallShallow)) },
            clinicProfiles: { S: JSON.stringify(clinicProfilesRaw.map(unmarshallShallow)) },
            members: { S: JSON.stringify(membersRaw.map(unmarshallShallow)) },
            ratingsReceived: { S: JSON.stringify(ratingsReceivedRaw.map(unmarshallShallow)) },
            mediaIndex: { S: JSON.stringify(mediaIndex) },
            accountSummary: { S: JSON.stringify(accountSummary) },
            completedJobs: { S: JSON.stringify(completedJobs) },
            completedApplications: { S: JSON.stringify(completedApplications) },
        };

        await ddb.send(new PutItemCommand({
            TableName: CLINIC_ACCOUNT_BACKUP_TABLE,
            Item: backupItem,
        }));

        // Verify.
        const verify = await ddb.send(new GetItemCommand({
            TableName: CLINIC_ACCOUNT_BACKUP_TABLE,
            Key: { ownerSub: { S: ownerSub }, deletedAt: { S: deletedAt } },
        }));
        if (!verify.Item) {
            return json(event, 500, {
                error: "Internal Server Error",
                statusCode: 500,
                message: "Backup write could not be verified; aborting deletion. Your account is unchanged.",
            });
        }

        // 7) Purge live data — child-first order.
        const deletes: DeleteKey[] = [];

        // Applications + invitations + negotiations
        for (const a of allAppsRaw) {
            const jobId = a.jobId?.S, applicationId = a.applicationId?.S;
            if (jobId && applicationId && JOB_APPLICATIONS_TABLE) {
                deletes.push({ TableName: JOB_APPLICATIONS_TABLE, Key: { jobId: { S: jobId }, applicationId: { S: applicationId } } });
            }
        }
        for (const inv of invitationsRaw) {
            const jobId = inv.jobId?.S, professionalUserSub = inv.professionalUserSub?.S;
            if (jobId && professionalUserSub && JOB_INVITATIONS_TABLE) {
                deletes.push({ TableName: JOB_INVITATIONS_TABLE, Key: { jobId: { S: jobId }, professionalUserSub: { S: professionalUserSub } } });
            }
        }
        for (const n of negotiationsRaw) {
            const applicationId = n.applicationId?.S, negotiationId = n.negotiationId?.S;
            if (applicationId && negotiationId && JOB_NEGOTIATIONS_TABLE) {
                deletes.push({ TableName: JOB_NEGOTIATIONS_TABLE, Key: { applicationId: { S: applicationId }, negotiationId: { S: negotiationId } } });
            }
        }
        // Jobs themselves (composite key clinicUserSub + jobId)
        for (const j of allJobsRaw) {
            const cus = j.clinicUserSub?.S, jobId = j.jobId?.S;
            if (cus && jobId && JOB_POSTINGS_TABLE) {
                deletes.push({ TableName: JOB_POSTINGS_TABLE, Key: { clinicUserSub: { S: cus }, jobId: { S: jobId } } });
            }
        }
        // Ratings received — ClinicRatings keyed (clinicId, professionalJobKey).
        for (const r of ratingsReceivedRaw) {
            if (!CLINIC_RATINGS_TABLE) break;
            const cid = r.clinicId?.S;
            const pjk = r.professionalJobKey?.S;
            if (cid && pjk) {
                deletes.push({
                    TableName: CLINIC_RATINGS_TABLE,
                    Key: { clinicId: { S: cid }, professionalJobKey: { S: pjk } },
                });
            }
        }
        // Members — UserClinicAssignments keyed (userSub PK, clinicId SK).
        for (const m of membersRaw) {
            const sub = m.userSub?.S, cid = m.clinicId?.S;
            if (sub && cid && USER_CLINIC_ASSIGNMENTS_TABLE) {
                deletes.push({
                    TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
                    Key: { userSub: { S: sub }, clinicId: { S: cid } },
                });
            }
        }
        // ClinicProfiles — keyed (clinicId PK, userSub SK). Both required.
        for (const p of clinicProfilesRaw) {
            const cid = p.clinicId?.S, sub = p.userSub?.S;
            if (cid && sub && CLINIC_PROFILES_TABLE) {
                deletes.push({
                    TableName: CLINIC_PROFILES_TABLE,
                    Key: { clinicId: { S: cid }, userSub: { S: sub } },
                });
            }
        }
        // Owner's notifications — Notifications keyed (userSub PK, notificationId SK).
        // Query by PK (no scan needed; userSub IS the partition key).
        if (NOTIFICATIONS_TABLE) {
            try {
                const notifs = await queryAllByPK(NOTIFICATIONS_TABLE, "userSub", ownerSub);
                for (const n of notifs) {
                    const sub = n.userSub?.S, nid = n.notificationId?.S;
                    if (sub && nid) {
                        deletes.push({
                            TableName: NOTIFICATIONS_TABLE,
                            Key: { userSub: { S: sub }, notificationId: { S: nid } },
                        });
                    }
                }
            } catch (err) {
                console.warn("[deleteClinicRootAccount] notifications query failed:", (err as Error).message);
            }
        }

        console.log(`[deleteClinicRootAccount] starting batch deletes, total keys queued: ${deletes.length}`);
        const failedBatches = await sendBatchDeletes(deletes);
        if (failedBatches.length > 0) {
            console.error("[deleteClinicRootAccount] One or more table batches failed:", JSON.stringify(failedBatches, null, 2));
            // Continue with S3 + Clinics deletes + Cognito anyway — the backup
            // row is the source of truth; orphan rows in failed tables can be
            // cleaned up later from the backup.
        }

        // Live S3 wipe — only AFTER all DynamoDB child rows are gone.
        if (PROFILE_IMAGES_BUCKET) {
            await deletePrefix(PROFILE_IMAGES_BUCKET, `${ownerSub}/`);
        }
        for (const cid of ownedClinicIds) {
            await deletePrefix(CLINIC_OFFICE_IMAGES_BUCKET, `clinic-office-image/${cid}/`);
        }

        // Finally, delete the Clinics rows themselves.
        for (const cid of ownedClinicIds) {
            try {
                await ddb.send(new DeleteItemCommand({
                    TableName: CLINICS_TABLE,
                    Key: { clinicId: { S: cid } },
                }));
            } catch (err) {
                console.error(`[deleteClinicRootAccount] Failed to delete clinic ${cid}:`, (err as Error).message);
            }
        }

        // Also strip this user from other clinics' AssociatedUsers where present.
        try {
            const associatedClinics = await scanByFilter(
                CLINICS_TABLE,
                "contains(AssociatedUsers, :sub)",
                { ":sub": { S: ownerSub } }
            );
            for (const c of associatedClinics) {
                const cid = c.clinicId?.S;
                if (!cid) continue;
                const current = (c.AssociatedUsers?.L || [])
                    .map(v => v.S)
                    .filter((v): v is string => !!v && v !== ownerSub);
                await ddb.send(new UpdateItemCommand({
                    TableName: CLINICS_TABLE,
                    Key: { clinicId: { S: cid } },
                    UpdateExpression: "SET AssociatedUsers = :u",
                    ExpressionAttributeValues: {
                        ":u": { L: current.map(s => ({ S: s })) },
                    },
                }));
            }
        } catch (err) {
            console.warn("[deleteClinicRootAccount] AssociatedUsers cleanup failed:", (err as Error).message);
        }

        // 8) Cognito: global signout, then delete the user.
        try {
            await cognito.send(new AdminUserGlobalSignOutCommand({
                UserPoolId: USER_POOL_ID,
                Username: ownerSub,
            }));
        } catch (err) {
            console.warn("[deleteClinicRootAccount] AdminUserGlobalSignOut failed (continuing):", (err as Error).message);
        }
        try {
            await cognito.send(new AdminDeleteUserCommand({
                UserPoolId: USER_POOL_ID,
                Username: ownerSub,
            }));
        } catch (err) {
            console.error("[deleteClinicRootAccount] AdminDeleteUser failed:", (err as Error).message);
            return json(event, 500, {
                error: "Internal Server Error",
                statusCode: 500,
                message: "Live data was purged but the Cognito user could not be deleted. A backup of your data is preserved. Contact support with this reference.",
                details: { backupId: `${ownerSub}#${deletedAt}` },
            });
        }

        return json(event, 200, {
            status: "deleted",
            statusCode: 200,
            message: "Your account has been permanently deleted. A backup has been retained for compliance.",
            data: {
                backupId: `${ownerSub}#${deletedAt}`,
                clinicsDeleted: ownedClinicIds.length,
                mediaCopied: mediaIndex.length,
                deletedAt,
            },
            timestamp: deletedAt,
        });
    } catch (error) {
        const err = error as Error;
        console.error("[deleteClinicRootAccount] Fatal error:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete account",
            details: { reason: err.message },
            timestamp: new Date().toISOString(),
        });
    }
};

exports.handler = handler;
