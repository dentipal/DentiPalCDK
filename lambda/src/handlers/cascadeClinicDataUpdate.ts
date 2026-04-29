import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBStreamEvent, DynamoDBRecord } from "aws-lambda";

// Background Lambda — fixes the denormalized clinic data on JobPostings
// when a clinic's address (Clinics table) or profile (Clinic-Profiles table)
// is edited. Existing handlers are unchanged; this runs out-of-band via
// DynamoDB Streams. Failure is non-fatal — worst case the system stays at
// today's stale-data state.

const REGION = process.env.REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });

const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;
const CLINIC_ID_INDEX = "ClinicIdIndex";

// Tables we care about — used to route incoming stream events to the right
// field-refresh logic. Sourced from env so dev / staging / prod can share code.
const CLINICS_TABLE = process.env.CLINICS_TABLE || "";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "";

type Img = { [key: string]: AttributeValue } | undefined;

const s = (img: Img, key: string): string | undefined => img?.[key]?.S;
const b = (img: Img, key: string): boolean | undefined => {
    const v = img?.[key];
    if (!v) return undefined;
    if (typeof v.BOOL === "boolean") return v.BOOL;
    return undefined;
};

const eventTableName = (record: DynamoDBRecord): string => {
    // eventSourceARN looks like:
    //   arn:aws:dynamodb:us-east-1:123:table/DentiPal-V5-Clinics/stream/2024-...
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

    const jobs = await queryActiveJobsForClinic(clinicId);
    if (jobs.length === 0) return;
    console.log(`[cascade] Refreshing profile fields on ${jobs.length} job(s) for clinic ${clinicId}`);

    await Promise.all(jobs.map(job => {
        const clinicUserSub = job.clinicUserSub?.S;
        const jobId = job.jobId?.S;
        if (!clinicUserSub || !jobId) return Promise.resolve();

        const sets: string[] = [];
        const values: Record<string, AttributeValue> = {};

        if (bookingOutPeriod !== undefined) {
            sets.push("bookingOutPeriod = :bop");
            values[":bop"] = { S: bookingOutPeriod };
        }
        if (clinicSoftware !== undefined) {
            sets.push("clinicSoftware = :cs");
            values[":cs"] = { S: clinicSoftware };
        }
        if (freeParkingAvailable !== undefined) {
            sets.push("freeParkingAvailable = :fp");
            values[":fp"] = { BOOL: freeParkingAvailable };
        }
        if (parkingType !== undefined) {
            sets.push("parkingType = :pt");
            values[":pt"] = { S: parkingType };
        }
        if (practiceType !== undefined) {
            sets.push("practiceType = :prt");
            values[":prt"] = { S: practiceType };
        }
        if (primaryPracticeArea !== undefined) {
            sets.push("primaryPracticeArea = :ppa");
            values[":ppa"] = { S: primaryPracticeArea };
        }

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

export const handler = async (event: DynamoDBStreamEvent): Promise<void> => {
    for (const record of event.Records) {
        try {
            // Only handle inserts/modifications. Deletes and removes don't have
            // a "new" state to copy onto job postings.
            if (record.eventName !== "MODIFY" && record.eventName !== "INSERT") continue;

            const newImage = record.dynamodb?.NewImage as Img;
            if (!newImage) continue;

            const tableName = eventTableName(record);
            const clinicId = s(newImage, "clinicId");
            if (!clinicId) {
                console.warn("[cascade] Skipping record — no clinicId on NewImage", { tableName });
                continue;
            }

            if (CLINICS_TABLE && tableName === CLINICS_TABLE) {
                await refreshAddressFields(clinicId, newImage);
            } else if (CLINIC_PROFILES_TABLE && tableName === CLINIC_PROFILES_TABLE) {
                await refreshProfileFields(clinicId, newImage);
            } else {
                console.warn("[cascade] Stream event from unexpected table", { tableName });
            }
        } catch (err) {
            // Catch-and-log so one bad record doesn't poison the whole batch.
            console.error("[cascade] Record-level failure", { error: (err as Error).message });
        }
    }
};
