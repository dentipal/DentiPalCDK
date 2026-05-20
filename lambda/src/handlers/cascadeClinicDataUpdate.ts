import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
    AttributeValue,
    BatchWriteItemCommand,
    ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { DynamoDBStreamEvent, DynamoDBRecord } from "aws-lambda";

// Background Lambda that does three things, all driven by DynamoDB Streams:
//
//   1. Clinics/ClinicProfiles MODIFY where the row was edited normally →
//      refresh denormalized address/profile fields on active JobPostings.
//   2. Clinics MODIFY where `deletedAt` was just set (soft delete) →
//      flip jobs to `status = clinic_deleted` so findJobs hides them.
//      Or where `deletedAt` was just cleared (restore) →
//      flip jobs back to `status = active`.
//   3. Clinics REMOVE (TTL fires 30 days after soft delete, or any other
//      true delete) → hard-cascade-purge every clinic-scoped row in every
//      table and every S3 object under the clinic's office-image prefix.
//
// Failure is non-fatal for the snapshot-sync paths (1 + 2). For (3) we let
// errors bubble so the Lambda retries on the next stream attempt and we
// don't silently leave orphans.

const REGION = process.env.REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });

const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;
const CLINIC_ID_INDEX = "ClinicIdIndex";

const CLINICS_TABLE = process.env.CLINICS_TABLE || "";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "";
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE || "";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "";
const USER_CLINIC_ASSIGNMENTS_TABLE = process.env.USER_CLINIC_ASSIGNMENTS_TABLE || "";
const CLINIC_FAVORITES_TABLE = process.env.CLINIC_FAVORITES_TABLE || "";
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || "";
const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE || "";
const CLINIC_OFFICE_IMAGES_BUCKET = process.env.CLINIC_OFFICE_IMAGES_BUCKET || "";

type Img = { [key: string]: AttributeValue } | undefined;

const s = (img: Img, key: string): string | undefined => img?.[key]?.S;
const b = (img: Img, key: string): boolean | undefined => {
    const v = img?.[key];
    if (!v) return undefined;
    if (typeof v.BOOL === "boolean") return v.BOOL;
    return undefined;
};

const eventTableName = (record: DynamoDBRecord): string => {
    const arn = record.eventSourceARN || "";
    const m = arn.match(/:table\/([^/]+)\//);
    return m ? m[1] : "";
};

const queryActiveJobsForClinic = async (clinicId: string) => {
    const out = await ddb.send(new QueryCommand({
        TableName: JOB_POSTINGS_TABLE,
        IndexName: CLINIC_ID_INDEX,
        KeyConditionExpression: "clinicId = :cid",
        ExpressionAttributeValues: { ":cid": { S: clinicId } },
    }));
    return out.Items || [];
};

const refreshAddressFields = async (clinicId: string, newImage: Img) => {
    if (!newImage) return;

    const addressLine1 = s(newImage, "addressLine1");
    const addressLine2 = s(newImage, "addressLine2") ?? "";
    const addressLine3 = s(newImage, "addressLine3") ?? "";
    const city = s(newImage, "city");
    const state = s(newImage, "state");
    const pincode = s(newImage, "pincode");

    if (!addressLine1 || !city || !state || !pincode) {
        console.log("[cascade] Skipping address refresh — clinic missing required address fields", { clinicId });
        return;
    }

    const fullAddress = `${addressLine1} ${addressLine2} ${addressLine3}`.trim();

    const jobs = await queryActiveJobsForClinic(clinicId);
    if (jobs.length === 0) return;
    console.log(`[cascade] Refreshing address on ${jobs.length} job(s) for clinic ${clinicId}`);

    await Promise.all(jobs.map(job => {
        const clinicUserSub = job.clinicUserSub?.S;
        const jobId = job.jobId?.S;
        if (!clinicUserSub || !jobId) return Promise.resolve();

        return ddb.send(new UpdateItemCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: clinicUserSub },
                jobId: { S: jobId },
            },
            UpdateExpression:
                "SET addressLine1 = :a1, addressLine2 = :a2, addressLine3 = :a3, " +
                "fullAddress = :fa, city = :ci, #st = :st, pincode = :pc, " +
                "updatedAt = :ts",
            ExpressionAttributeNames: { "#st": "state" },
            ExpressionAttributeValues: {
                ":a1": { S: addressLine1 },
                ":a2": { S: addressLine2 },
                ":a3": { S: addressLine3 },
                ":fa": { S: fullAddress },
                ":ci": { S: city },
                ":st": { S: state },
                ":pc": { S: pincode },
                ":ts": { S: new Date().toISOString() },
            },
        })).catch(err => {
            console.error("[cascade] Failed to update job address", { clinicId, jobId, error: (err as Error).message });
        });
    }));
};

const refreshProfileFields = async (clinicId: string, newImage: Img) => {
    if (!newImage) return;

    const bookingOutPeriod = s(newImage, "booking_out_period");
    const clinicSoftware = s(newImage, "clinic_software");
    const freeParkingAvailable = b(newImage, "free_parking_available");
    const parkingType = s(newImage, "parking_type");
    const practiceType = s(newImage, "practice_type");
    const primaryPracticeArea = s(newImage, "primary_practice_area");
    const locationUrl = s(newImage, "location_url");

    const jobs = await queryActiveJobsForClinic(clinicId);
    if (jobs.length === 0) return;
    console.log(`[cascade] Refreshing profile fields on ${jobs.length} job(s) for clinic ${clinicId}`);

    await Promise.all(jobs.map(job => {
        const clinicUserSub = job.clinicUserSub?.S;
        const jobId = job.jobId?.S;
        if (!clinicUserSub || !jobId) return Promise.resolve();

        const sets: string[] = [];
        const values: Record<string, AttributeValue> = {};

        if (bookingOutPeriod !== undefined) { sets.push("bookingOutPeriod = :bop"); values[":bop"] = { S: bookingOutPeriod }; }
        if (clinicSoftware !== undefined) { sets.push("clinicSoftware = :cs"); values[":cs"] = { S: clinicSoftware }; }
        if (freeParkingAvailable !== undefined) { sets.push("freeParkingAvailable = :fp"); values[":fp"] = { BOOL: freeParkingAvailable }; }
        if (parkingType !== undefined) { sets.push("parkingType = :pt"); values[":pt"] = { S: parkingType }; }
        if (practiceType !== undefined) { sets.push("practiceType = :prt"); values[":prt"] = { S: practiceType }; }
        if (primaryPracticeArea !== undefined) { sets.push("primaryPracticeArea = :ppa"); values[":ppa"] = { S: primaryPracticeArea }; }
        if (locationUrl !== undefined) { sets.push("locationUrl = :lurl"); values[":lurl"] = { S: locationUrl }; }

        if (sets.length === 0) return Promise.resolve();

        sets.push("updatedAt = :ts");
        values[":ts"] = { S: new Date().toISOString() };

        return ddb.send(new UpdateItemCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: clinicUserSub },
                jobId: { S: jobId },
            },
            UpdateExpression: `SET ${sets.join(", ")}`,
            ExpressionAttributeValues: values,
        })).catch(err => {
            console.error("[cascade] Failed to update job profile fields", { clinicId, jobId, error: (err as Error).message });
        });
    }));
};

// Flip every active job for the clinic to status = clinic_deleted (or the
// other way around when a clinic is restored). findJobs filters by
// status = active so this is how soft-deleted clinics disappear from the
// professional-side job feed without us touching the job rows' fields.
const setJobsClinicDeletedStatus = async (clinicId: string, newStatus: "clinic_deleted" | "active") => {
    const jobs = await queryActiveJobsForClinic(clinicId);
    if (jobs.length === 0) return;
    console.log(`[cascade] Setting status=${newStatus} on ${jobs.length} job(s) for clinic ${clinicId}`);

    await Promise.all(jobs.map(job => {
        const clinicUserSub = job.clinicUserSub?.S;
        const jobId = job.jobId?.S;
        if (!clinicUserSub || !jobId) return Promise.resolve();

        return ddb.send(new UpdateItemCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: clinicUserSub },
                jobId: { S: jobId },
            },
            UpdateExpression: "SET #st = :st, updatedAt = :ts",
            ExpressionAttributeNames: { "#st": "status" },
            ExpressionAttributeValues: {
                ":st": { S: newStatus },
                ":ts": { S: new Date().toISOString() },
            },
        })).catch(err => {
            console.error("[cascade] Failed to flip job status", { clinicId, jobId, newStatus, error: (err as Error).message });
        });
    }));
};

// ─────────────────────────────────────────────────────────────────────────────
// Hard purge — fires when TTL deletes the Clinics row (30 days post soft-delete)
// ─────────────────────────────────────────────────────────────────────────────

type DeleteKey = { TableName: string; Key: Record<string, AttributeValue> };

const sendBatchDeletes = async (deletes: DeleteKey[]) => {
    if (deletes.length === 0) return;
    const CHUNK = 25;
    for (let i = 0; i < deletes.length; i += CHUNK) {
        const batch = deletes.slice(i, i + CHUNK);
        const RequestItems: Record<string, { DeleteRequest: { Key: Record<string, AttributeValue> } }[]> = {};
        for (const d of batch) {
            (RequestItems[d.TableName] ||= []).push({ DeleteRequest: { Key: d.Key } });
        }

        let unprocessed = RequestItems;
        for (let attempt = 0; attempt < 5; attempt++) {
            const resp = await ddb.send(new BatchWriteItemCommand({ RequestItems: unprocessed }));
            const left = resp.UnprocessedItems || {};
            if (Object.keys(left).length === 0) break;
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt))); // 100ms, 200ms, 400ms...
            unprocessed = left as any;
            if (attempt === 4) {
                console.error("[cascade-purge] UnprocessedItems remain after 5 retries; some rows may persist", { left });
            }
        }
    }
};

// Find every job for the clinic across ALL statuses (active, scheduled, completed,
// clinic_deleted) and queue them — plus their applications, invitations,
// negotiations — for deletion.
const collectJobChildren = async (clinicId: string, deletes: DeleteKey[]) => {
    if (!JOB_POSTINGS_TABLE) return;

    // Query the GSI for every job (no status filter — purge means purge).
    let exclusiveStart: Record<string, AttributeValue> | undefined;
    const jobs: { clinicUserSub: string; jobId: string }[] = [];
    do {
        const out = await ddb.send(new QueryCommand({
            TableName: JOB_POSTINGS_TABLE,
            IndexName: CLINIC_ID_INDEX,
            KeyConditionExpression: "clinicId = :cid",
            ExpressionAttributeValues: { ":cid": { S: clinicId } },
            ExclusiveStartKey: exclusiveStart,
        }));
        for (const item of out.Items || []) {
            const clinicUserSub = item.clinicUserSub?.S;
            const jobId = item.jobId?.S;
            if (clinicUserSub && jobId) jobs.push({ clinicUserSub, jobId });
        }
        exclusiveStart = out.LastEvaluatedKey;
    } while (exclusiveStart);

    for (const j of jobs) {
        deletes.push({
            TableName: JOB_POSTINGS_TABLE,
            Key: { clinicUserSub: { S: j.clinicUserSub }, jobId: { S: j.jobId } },
        });

        // Applications for this job (via JobIndex GSI).
        if (JOB_APPLICATIONS_TABLE) {
            try {
                const apps = await ddb.send(new QueryCommand({
                    TableName: JOB_APPLICATIONS_TABLE,
                    IndexName: "JobIndex",
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: j.jobId } },
                }));
                for (const app of apps.Items || []) {
                    if (app.jobId?.S && app.applicationId?.S) {
                        deletes.push({
                            TableName: JOB_APPLICATIONS_TABLE,
                            Key: { jobId: { S: app.jobId.S }, applicationId: { S: app.applicationId.S } },
                        });
                        // Negotiations keyed by applicationId.
                        if (JOB_NEGOTIATIONS_TABLE) {
                            try {
                                const negs = await ddb.send(new QueryCommand({
                                    TableName: JOB_NEGOTIATIONS_TABLE,
                                    KeyConditionExpression: "applicationId = :aid",
                                    ExpressionAttributeValues: { ":aid": { S: app.applicationId.S } },
                                }));
                                for (const n of negs.Items || []) {
                                    if (n.applicationId?.S && n.negotiationId?.S) {
                                        deletes.push({
                                            TableName: JOB_NEGOTIATIONS_TABLE,
                                            Key: {
                                                applicationId: { S: n.applicationId.S },
                                                negotiationId: { S: n.negotiationId.S },
                                            },
                                        });
                                    }
                                }
                            } catch (err) {
                                console.warn("[cascade-purge] negotiations query failed (continuing)", { applicationId: app.applicationId.S, error: (err as Error).message });
                            }
                        }
                    }
                }
            } catch (err) {
                console.warn("[cascade-purge] applications query failed (continuing)", { jobId: j.jobId, error: (err as Error).message });
            }
        }

        // Invitations keyed by jobId.
        if (JOB_INVITATIONS_TABLE) {
            try {
                const invs = await ddb.send(new QueryCommand({
                    TableName: JOB_INVITATIONS_TABLE,
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: j.jobId } },
                }));
                for (const inv of invs.Items || []) {
                    if (inv.jobId?.S && inv.professionalUserSub?.S) {
                        deletes.push({
                            TableName: JOB_INVITATIONS_TABLE,
                            Key: {
                                jobId: { S: inv.jobId.S },
                                professionalUserSub: { S: inv.professionalUserSub.S },
                            },
                        });
                    }
                }
            } catch (err) {
                console.warn("[cascade-purge] invitations query failed (continuing)", { jobId: j.jobId, error: (err as Error).message });
            }
        }
    }
};

const collectScanByClinicId = async (
    tableName: string,
    clinicId: string,
    deletes: DeleteKey[],
    keyExtractor: (item: Record<string, AttributeValue>) => Record<string, AttributeValue> | null
) => {
    if (!tableName) return;
    let exclusiveStart: Record<string, AttributeValue> | undefined;
    try {
        do {
            const out = await ddb.send(new ScanCommand({
                TableName: tableName,
                FilterExpression: "clinicId = :cid",
                ExpressionAttributeValues: { ":cid": { S: clinicId } },
                ExclusiveStartKey: exclusiveStart,
            }));
            for (const item of out.Items || []) {
                const key = keyExtractor(item);
                if (key) deletes.push({ TableName: tableName, Key: key });
            }
            exclusiveStart = out.LastEvaluatedKey;
        } while (exclusiveStart);
    } catch (err) {
        console.warn(`[cascade-purge] scan failed for ${tableName} (continuing)`, { clinicId, error: (err as Error).message });
    }
};

const purgeS3ClinicImages = async (clinicId: string) => {
    if (!CLINIC_OFFICE_IMAGES_BUCKET) return;
    const Prefix = `clinic-office-image/${clinicId}/`;
    let ContinuationToken: string | undefined;
    try {
        do {
            const list = await s3.send(new ListObjectsV2Command({
                Bucket: CLINIC_OFFICE_IMAGES_BUCKET,
                Prefix,
                ContinuationToken,
            }));
            const keys = (list.Contents || []).map(o => ({ Key: o.Key! })).filter(o => o.Key);
            if (keys.length > 0) {
                // S3 DeleteObjects supports up to 1000 at a time, which matches ListObjectsV2's default page.
                await s3.send(new DeleteObjectsCommand({
                    Bucket: CLINIC_OFFICE_IMAGES_BUCKET,
                    Delete: { Objects: keys, Quiet: true },
                }));
            }
            ContinuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (ContinuationToken);
    } catch (err) {
        console.error("[cascade-purge] S3 image purge failed", { clinicId, error: (err as Error).message });
    }
};

const hardPurgeClinic = async (clinicId: string) => {
    console.log(`[cascade-purge] Starting hard purge for clinic ${clinicId}`);
    const deletes: DeleteKey[] = [];

    // 1. ClinicProfiles — assume PK clinicId, optional SK. Query first; fall back to scan.
    if (CLINIC_PROFILES_TABLE) {
        try {
            const profiles = await ddb.send(new QueryCommand({
                TableName: CLINIC_PROFILES_TABLE,
                KeyConditionExpression: "clinicId = :cid",
                ExpressionAttributeValues: { ":cid": { S: clinicId } },
            }));
            for (const p of profiles.Items || []) {
                const key: Record<string, AttributeValue> = { clinicId: { S: clinicId } };
                // ClinicProfiles uses profileId as sort key in some envs; include if present.
                if (p.profileId?.S) key.profileId = { S: p.profileId.S };
                deletes.push({ TableName: CLINIC_PROFILES_TABLE, Key: key });
            }
        } catch (err) {
            // If the table is keyed only by clinicId (no SK), query without SK works,
            // and the key { clinicId } above is enough. If neither, log and move on.
            console.warn("[cascade-purge] ClinicProfiles query failed; trying scan", { clinicId, error: (err as Error).message });
            await collectScanByClinicId(CLINIC_PROFILES_TABLE, clinicId, deletes, (item) => {
                const key: Record<string, AttributeValue> = { clinicId: { S: clinicId } };
                if (item.profileId?.S) key.profileId = { S: item.profileId.S };
                return key;
            });
        }
    }

    // 2. UserClinicAssignments — typically (clinicId PK, userSub SK)
    if (USER_CLINIC_ASSIGNMENTS_TABLE) {
        try {
            const out = await ddb.send(new QueryCommand({
                TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
                KeyConditionExpression: "clinicId = :cid",
                ExpressionAttributeValues: { ":cid": { S: clinicId } },
            }));
            for (const item of out.Items || []) {
                if (item.userSub?.S) {
                    deletes.push({
                        TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
                        Key: { clinicId: { S: clinicId }, userSub: { S: item.userSub.S } },
                    });
                }
            }
        } catch (err) {
            console.warn("[cascade-purge] UserClinicAssignments query failed (continuing)", { error: (err as Error).message });
        }
    }

    // 3. JobPostings + all their applications/invitations/negotiations
    await collectJobChildren(clinicId, deletes);

    // 4. ClinicFavorites — assume (userSub PK, clinicId SK) — Scan needed
    await collectScanByClinicId(CLINIC_FAVORITES_TABLE, clinicId, deletes, (item) => {
        if (item.userSub?.S) {
            return { userSub: { S: item.userSub.S }, clinicId: { S: clinicId } };
        }
        return null;
    });

    // 5. Feedback (ratings) — table shape varies; try several common key shapes
    await collectScanByClinicId(FEEDBACK_TABLE, clinicId, deletes, (item) => {
        if (item.feedbackId?.S) return { feedbackId: { S: item.feedbackId.S } };
        if (item.ratingId?.S) return { ratingId: { S: item.ratingId.S } };
        if (item.id?.S) return { id: { S: item.id.S } };
        return null;
    });

    // 6. Notifications referencing this clinic
    await collectScanByClinicId(NOTIFICATIONS_TABLE, clinicId, deletes, (item) => {
        if (item.notificationId?.S && item.userSub?.S) {
            return { userSub: { S: item.userSub.S }, notificationId: { S: item.notificationId.S } };
        }
        if (item.notificationId?.S) return { notificationId: { S: item.notificationId.S } };
        return null;
    });

    // Per product decision: Conversations + Messages are NOT purged. They keep
    // the chat history alive for the other participant; the clinic identity
    // resolves through DeletedClinicSnapshots and renders as the fallback UI.

    console.log(`[cascade-purge] Queued ${deletes.length} row(s) for deletion`);
    await sendBatchDeletes(deletes);

    // 7. S3 — last, because the DynamoDB cleanup is what the rest of the
    //    system reads. If S3 fails, the orphan is just a few KB of blob storage.
    await purgeS3ClinicImages(clinicId);

    console.log(`[cascade-purge] Done for clinic ${clinicId}`);
};

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const wasJustSoftDeleted = (oldImage: Img, newImage: Img): boolean =>
    !oldImage?.deletedAt && !!newImage?.deletedAt;

const wasJustRestored = (oldImage: Img, newImage: Img): boolean =>
    !!oldImage?.deletedAt && !newImage?.deletedAt;

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
    for (const record of event.Records) {
        try {
            const tableName = eventTableName(record);
            const eventName = record.eventName;
            const newImage = record.dynamodb?.NewImage as Img;
            const oldImage = record.dynamodb?.OldImage as Img;

            if (eventName === "REMOVE") {
                // TTL fires here too (DynamoDB still emits REMOVE for TTL deletes).
                // Only purge on Clinics REMOVE — other tables aren't wired to this stream.
                if (CLINICS_TABLE && tableName === CLINICS_TABLE) {
                    const clinicId = s(oldImage, "clinicId");
                    if (clinicId) {
                        await hardPurgeClinic(clinicId);
                    }
                }
                continue;
            }

            if (eventName !== "MODIFY" && eventName !== "INSERT") continue;
            if (!newImage) continue;

            const clinicId = s(newImage, "clinicId");
            if (!clinicId) {
                console.warn("[cascade] Skipping record — no clinicId on NewImage", { tableName });
                continue;
            }

            // Soft-delete / restore transitions on the Clinics row → flip job statuses.
            if (CLINICS_TABLE && tableName === CLINICS_TABLE) {
                if (wasJustSoftDeleted(oldImage, newImage)) {
                    await setJobsClinicDeletedStatus(clinicId, "clinic_deleted");
                    continue; // don't try to refresh address on a deleted clinic
                }
                if (wasJustRestored(oldImage, newImage)) {
                    await setJobsClinicDeletedStatus(clinicId, "active");
                    // fall through — also refresh address in case it changed during the delete window
                }
                // Skip the snapshot refresh if the clinic is currently in the soft-deleted state.
                if (newImage.deletedAt?.S) continue;

                await refreshAddressFields(clinicId, newImage);
            } else if (CLINIC_PROFILES_TABLE && tableName === CLINIC_PROFILES_TABLE) {
                await refreshProfileFields(clinicId, newImage);
            } else {
                console.warn("[cascade] Stream event from unexpected table", { tableName });
            }
        } catch (err) {
            console.error("[cascade] Record-level failure", { error: (err as Error).message });
        }
    }
};
