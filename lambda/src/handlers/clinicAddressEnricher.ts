// clinicAddressEnricher.ts
//
// Read-time enrichment helper. Given a list of records that each carry a
// `clinicId`, batch-fetch the current clinic address from the Clinics table
// and overwrite the snapshotted address fields on each record in the
// response.
//
// IMPORTANT — this helper is purely additive:
//   * It does NOT mutate any DynamoDB row. The snapshot stored on the
//     job/application row remains untouched in the database — only the
//     in-flight response object is rewritten.
//   * It NEVER throws. Any failure (missing env var, clinic not found,
//     DynamoDB error) leaves the input record unchanged so existing
//     functionality keeps working exactly as it does today.
//   * Records without a clinicId, or whose clinic lookup returns nothing,
//     pass through untouched.
//
// Call site is a single line right before returning the API response.

import {
    DynamoDBClient,
    BatchGetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "";

const ddb = new DynamoDBClient({ region: REGION });

// Fields we read off the Clinics row. Keep the projection narrow so we
// never accidentally pull sensitive columns into the response.
const CLINIC_PROJECTION = "clinicId, #nm, addressLine1, addressLine2, addressLine3, city, #st, pincode";
const CLINIC_PROJECTION_NAMES = { "#nm": "name", "#st": "state" } as const;

export interface LiveClinicAddress {
    clinicId: string;
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    state?: string;
    pincode?: string;
    /** Joined single-line representation — same format the cascade Lambda writes. */
    fullAddress?: string;
}

/**
 * Build a single-line display address from the parts, identical in spirit to
 * the `fullAddress` value that cascadeClinicDataUpdate.ts already writes onto
 * job postings — so consumers that already read `fullAddress` get a value in
 * the same shape they're used to.
 */
function joinAddress(parts: {
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
}): string {
    return [parts.addressLine1, parts.addressLine2, parts.addressLine3]
        .map((p) => (p ?? "").trim())
        .filter((p) => p.length > 0)
        .join(" ");
}

/**
 * Batch-fetch live clinic address rows for the given unique clinicIds.
 * Returns a Map keyed by clinicId. Missing clinics / errors → entry omitted.
 */
export async function fetchLiveClinicAddresses(
    clinicIds: string[]
): Promise<Map<string, LiveClinicAddress>> {
    const out = new Map<string, LiveClinicAddress>();
    if (!CLINICS_TABLE || !clinicIds || clinicIds.length === 0) return out;

    // De-dupe + drop empties so BatchGetItem keys are unique.
    const uniqueIds = Array.from(
        new Set(clinicIds.filter((id): id is string => typeof id === "string" && id.length > 0))
    );
    if (uniqueIds.length === 0) return out;

    // BatchGetItem allows up to 100 keys per call — chunk for safety.
    const CHUNK = 100;
    for (let i = 0; i < uniqueIds.length; i += CHUNK) {
        const chunk = uniqueIds.slice(i, i + CHUNK);
        try {
            const resp = await ddb.send(new BatchGetItemCommand({
                RequestItems: {
                    [CLINICS_TABLE]: {
                        Keys: chunk.map((id) => ({ clinicId: { S: id } })),
                        ProjectionExpression: CLINIC_PROJECTION,
                        ExpressionAttributeNames: CLINIC_PROJECTION_NAMES,
                    },
                },
            }));

            const items = resp.Responses?.[CLINICS_TABLE] || [];
            for (const raw of items) {
                const row = unmarshall(raw as Record<string, AttributeValue>);
                const id: string | undefined = row.clinicId;
                if (!id) continue;
                const addr: LiveClinicAddress = {
                    clinicId: id,
                    name: row.name,
                    addressLine1: row.addressLine1,
                    addressLine2: row.addressLine2,
                    addressLine3: row.addressLine3,
                    city: row.city,
                    state: row.state,
                    pincode: row.pincode,
                };
                addr.fullAddress = joinAddress(addr);
                out.set(id, addr);
            }
        } catch (err) {
            // Swallow & log: enrichment is best-effort. Stale snapshot remains
            // in the response on failure — same as today's behaviour.
            console.warn(
                "[clinicAddressEnricher] BatchGetItem failed; leaving snapshot untouched for this chunk",
                { error: (err as Error)?.message, count: chunk.length }
            );
        }
    }

    return out;
}

/**
 * Overwrite snapshotted clinic-address fields on a single record with the
 * given live values. Returns a SHALLOW COPY — the original input object is
 * not mutated. Unrelated fields are preserved as-is.
 */
export function applyLiveClinicAddress<T extends Record<string, any>>(
    record: T | null | undefined,
    live: LiveClinicAddress | undefined
): T | null | undefined {
    if (!record || !live) return record;

    // Only overwrite fields the clinic actually has values for; leave others
    // (and anything non-address) untouched.
    const patch: Record<string, any> = {};
    if (live.addressLine1 !== undefined) patch.addressLine1 = live.addressLine1;
    if (live.addressLine2 !== undefined) patch.addressLine2 = live.addressLine2;
    if (live.addressLine3 !== undefined) patch.addressLine3 = live.addressLine3;
    if (live.city !== undefined) patch.city = live.city;
    if (live.state !== undefined) patch.state = live.state;
    if (live.pincode !== undefined) {
        patch.pincode = live.pincode;
        // Some frontends read `zipCode`; keep both in sync without removing
        // any existing key the consumer might still rely on.
        patch.zipCode = live.pincode;
    }
    if (live.fullAddress !== undefined) {
        patch.fullAddress = live.fullAddress;
        // Legacy display field names used by some frontends — keep in sync.
        patch.location = live.fullAddress;
        patch.address = live.fullAddress;
    }
    if (live.name !== undefined) {
        // Only refresh clinic *name* fields, never overwrite professional /
        // applicant names that may live on the same record under different keys.
        if ("clinicName" in record) patch.clinicName = live.name;
        if ("OfficeName" in record) patch.OfficeName = live.name;
    }

    // Some handlers return address under a nested `location` object —
    // e.g. getAllTemporaryJobs / getAllPermanentJobsForClinic. When that
    // shape exists, mirror the patch into it so consumers reading
    // `job.location.addressLine1` also see the live values. We only touch
    // the address keys; any other keys on `location` (contactInfo etc.)
    // are preserved as-is.
    const existingLocation = (record as any).location;
    if (existingLocation && typeof existingLocation === "object" && !Array.isArray(existingLocation)) {
        const locPatch: Record<string, any> = {};
        if (live.addressLine1 !== undefined) locPatch.addressLine1 = live.addressLine1;
        if (live.addressLine2 !== undefined) locPatch.addressLine2 = live.addressLine2;
        if (live.addressLine3 !== undefined) locPatch.addressLine3 = live.addressLine3;
        if (live.city !== undefined) locPatch.city = live.city;
        if (live.state !== undefined) locPatch.state = live.state;
        if (live.pincode !== undefined) {
            locPatch.pincode = live.pincode;
            // Frontend shape uses `zipCode` inside nested location.
            locPatch.zipCode = live.pincode;
        }
        if (Object.keys(locPatch).length > 0) {
            patch.location = { ...existingLocation, ...locPatch };
        }
    }

    return { ...record, ...patch };
}

/**
 * Convenience wrapper: enrich a list of records that each have a `clinicId`.
 * Performs ONE batched lookup then maps over the list. Never throws.
 *
 *   const fresh = await enrichRecordsWithLiveClinicAddress(jobs);
 *
 * Records without a clinicId or whose clinic isn't found are returned as-is.
 */
export async function enrichRecordsWithLiveClinicAddress<
    T extends Record<string, any>
>(records: (T | null | undefined)[]): Promise<(T | null | undefined)[]> {
    if (!records || records.length === 0) return records;

    const clinicIds = records
        .map((r) => r?.clinicId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);

    if (clinicIds.length === 0) return records;

    const liveMap = await fetchLiveClinicAddresses(clinicIds);
    if (liveMap.size === 0) return records;

    return records.map((r) => {
        if (!r) return r;
        const live = liveMap.get(r.clinicId);
        if (!live) return r;
        return applyLiveClinicAddress(r, live);
    });
}
