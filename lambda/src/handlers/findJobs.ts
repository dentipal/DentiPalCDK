import {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
  UpdateItemCommand,
  AttributeValue,
  ScanCommandInput,
  ScanCommandOutput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";
import { fireAndForgetIncrement } from "./promotionCounters";
import { geocodeAddressParts } from "./geo";
const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

// --- Interfaces ---

interface ClinicInfo {
  name: string;
  contactName: string;
  lat?: number | null;
  lng?: number | null;
}

interface JobPosting {
  jobId: string;
  jobType: string;
  professionalRole: string;
  /** Multi-role jobs store an array. Needed for the role multi-select filter. */
  professionalRoles?: string[];
  status: string;
  createdAt: string;
  updatedAt: string;

  // Common fields
  jobTitle?: string;
  jobDescription?: string;

  // Rate/Salary fields
  rate?: number | null;
  payType?: string;
  salaryMin?: number;
  salaryMax?: number;

  // Date/Time fields
  date?: string;
  dates?: string[];
  startDate?: string;
  hours?: number;
  startTime?: string;
  endTime?: string;

  // Location details
  city?: string;
  state?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  /** Copied from the clinic row (or the job row if denormalized there). Enables
   *  the frontend's haversine-based "Near me" radius filter. Null when no
   *  geocode is available — those jobs are naturally excluded from radius results. */
  lat?: number | null;
  lng?: number | null;

  // Work & shift metadata — surfaced for the filter panel + expanded card.
  workLocationType?: string;
  shiftSpeciality?: string;
  requirements?: string[];
  clinicSoftware?: string[];
  parkingType?: string;
  freeParkingAvailable?: boolean;

  // Promotion fields
  isPromoted?: boolean;
  promotionId?: string;
  promotionPlanId?: string;
  promotionExpiresAt?: string;

  // Enriched Data
  clinic?: ClinicInfo;
}

/** Normalize a DynamoDB attribute that may be SS, L of {S}, or a single S into string[]. */
function toStringArray(attr: any): string[] {
  if (!attr) return [];
  if (Array.isArray(attr.SS)) return attr.SS.filter((v: unknown): v is string => typeof v === "string");
  if (Array.isArray(attr.L)) {
    return attr.L
      .map((v: any) => (typeof v?.S === "string" ? v.S : null))
      .filter((v: string | null): v is string => v !== null && v.length > 0);
  }
  if (typeof attr.S === "string" && attr.S.length > 0) return [attr.S];
  return [];
}

/** Parse a DynamoDB Number attribute into a finite number, or null. */
function toNumber(attr: any): number | null {
  if (!attr?.N) return null;
  const v = parseFloat(attr.N);
  return Number.isFinite(v) ? v : null;
}

// --- Helper Functions ---

/**
 * Fetch display info from the CLINIC_PROFILES_TABLE (clinic_name, contact).
 */
async function fetchClinicInfo(clinicUserSub: string): Promise<ClinicInfo | undefined> {
  try {
    const clinicCommand = new GetItemCommand({
      TableName: process.env.CLINIC_PROFILES_TABLE,
      Key: { userSub: { S: clinicUserSub } },
      ProjectionExpression: "clinic_name, primary_contact_first_name, primary_contact_last_name",
    });

    const clinicResponse = await dynamodb.send(clinicCommand);

    if (clinicResponse.Item) {
      const clinic = clinicResponse.Item;
      const firstName = clinic.primary_contact_first_name?.S || "";
      const lastName = clinic.primary_contact_last_name?.S || "";

      return {
        name: clinic.clinic_name?.S || "Unknown Clinic",
        contactName: `${firstName} ${lastName}`.trim() || "Contact",
      };
    }
  } catch (e) {
    console.warn(`Failed to fetch clinic details for ${clinicUserSub}:`, e);
  }
  return undefined;
}

/**
 * Fetch clinic geo-coords from the CLINICS_TABLE (keyed by clinicId, which is
 * what's stored on the job row). Returns { lat, lng } when the clinic has them;
 * otherwise returns the raw address fields so the caller can geocode on the fly.
 *
 * This is separate from fetchClinicInfo because the two bits of info live in
 * different tables — `clinic_name`/contact in CLINIC_PROFILES_TABLE, and the
 * address + geo in CLINICS_TABLE.
 */
interface ClinicGeo {
  lat: number | null;
  lng: number | null;
  addressLine1: string;
  city: string;
  state: string;
  pincode: string;
}

async function fetchClinicGeo(clinicId: string): Promise<ClinicGeo | undefined> {
  if (!process.env.CLINICS_TABLE) return undefined;
  try {
    const resp = await dynamodb.send(new GetItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Key: { clinicId: { S: clinicId } },
      ProjectionExpression: "lat, lng, addressLine1, city, #st, pincode",
      ExpressionAttributeNames: { "#st": "state" },
    }));

    if (!resp.Item) return undefined;
    const item = resp.Item;
    return {
      lat: toNumber(item.lat),
      lng: toNumber(item.lng),
      addressLine1: item.addressLine1?.S || "",
      city: item.city?.S || "",
      state: item.state?.S || "",
      pincode: item.pincode?.S || "",
    };
  } catch (e) {
    console.warn(`[findJobs] Failed to fetch geo for clinic ${clinicId}:`, e);
  }
  return undefined;
}

/**
 * Write freshly-geocoded coords back to the clinic row so subsequent reads
 * don't re-geocode. Fire-and-forget — never blocks the response.
 */
function persistClinicGeo(clinicId: string, lat: number, lng: number): void {
  if (!process.env.CLINICS_TABLE) return;
  dynamodb.send(new UpdateItemCommand({
    TableName: process.env.CLINICS_TABLE,
    Key: { clinicId: { S: clinicId } },
    UpdateExpression: "SET lat = :lat, lng = :lng",
    ExpressionAttributeValues: {
      ":lat": { N: String(lat) },
      ":lng": { N: String(lng) },
    },
  })).catch((err) => {
    console.warn(`[findJobs] Could not persist coords for clinic ${clinicId}:`, err);
  });
}

/**
 * Returns { lat, lng } for a clinic, geocoding on the fly if the row doesn't
 * already have them. When a fresh geocode succeeds, it's persisted back so the
 * self-heal amortizes across subsequent requests. Null when we genuinely can't
 * resolve (missing address, external service down, etc.) — those jobs will be
 * excluded from radius-filtered results, which is the correct behavior.
 *
 * Process-level cache prevents re-geocoding the same clinic inside a single
 * Lambda invocation when multiple jobs share a clinic.
 */
const geoCache = new Map<string, { lat: number; lng: number } | null>();

async function resolveClinicCoords(clinicId: string): Promise<{ lat: number | null; lng: number | null }> {
  if (!clinicId) return { lat: null, lng: null };

  const cached = geoCache.get(clinicId);
  if (cached !== undefined) {
    return cached ?? { lat: null, lng: null };
  }

  const geo = await fetchClinicGeo(clinicId);
  if (!geo) {
    geoCache.set(clinicId, null);
    return { lat: null, lng: null };
  }

  if (geo.lat != null && geo.lng != null) {
    const resolved = { lat: geo.lat, lng: geo.lng };
    geoCache.set(clinicId, resolved);
    return resolved;
  }

  // Fresh geocode path — the clinic has an address but no stored coords.
  // Common for rows created before geocoding was wired into createClinic.
  const coords = await geocodeAddressParts({
    addressLine1: geo.addressLine1,
    city: geo.city,
    state: geo.state,
    pincode: geo.pincode,
  });
  if (coords) {
    persistClinicGeo(clinicId, coords.lat, coords.lng);
    geoCache.set(clinicId, coords);
    return coords;
  }

  geoCache.set(clinicId, null);
  return { lat: null, lng: null };
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
  // Define CORS headers
 

  try {
    const jobPostings: JobPosting[] = [];
    
    // Explicitly type the key to handle DynamoDB pagination
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;

    // Paginate through all active jobs
    do {
      const scanParams: ScanCommandInput = {
        TableName: process.env.JOB_POSTINGS_TABLE,
        FilterExpression: "#st = :active",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":active": { S: "active" } },
        ExclusiveStartKey,
      };

      const scanCommand = new ScanCommand(scanParams);
      
      // Explicitly type the response to access LastEvaluatedKey safely
      const scanResponse: ScanCommandOutput = await dynamodb.send(scanCommand);

      if (scanResponse.Items) {
        for (const item of scanResponse.Items) {
          // Base object construction
          const job: JobPosting = {
            jobId: item.jobId?.S || "",
            jobType: item.job_type?.S || "",
            professionalRole: item.professional_role?.S || "",
            status: item.status?.S || "active",
            createdAt: item.createdAt?.S || "",
            updatedAt: item.updatedAt?.S || "",
          };

          // Common fields
          if (item.job_title?.S) job.jobTitle = item.job_title.S;
          if (item.job_description?.S) job.jobDescription = item.job_description.S;

          // Multi-role support — `professionalRoles` stored as SS or L. The
          // frontend role filter checks this array first, falling back to
          // the single `professionalRole` we already emit.
          const roles = toStringArray(item.professional_roles);
          if (roles.length > 0) job.professionalRoles = roles;

          // Rate/Salary fields
          job.rate = item.rate?.N ? parseFloat(item.rate.N) : (item.pay_type?.S === "per_transaction" ? (item.rate_per_transaction?.N ? parseFloat(item.rate_per_transaction.N) : null) : item.pay_type?.S === "percentage_of_revenue" ? (item.revenue_percentage?.N ? parseFloat(item.revenue_percentage.N) : null) : (item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : null));
          job.payType = item.pay_type?.S || "per_hour";
          if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
          if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);

          // Date/Time specific fields based on jobType
          if (item.job_type?.S === 'temporary') {
            if (item.date?.S) job.date = item.date.S;
            if (item.hours?.N) job.hours = parseFloat(item.hours.N);
            if (item.start_time?.S) job.startTime = item.start_time.S;
            if (item.end_time?.S) job.endTime = item.end_time.S;
          } else if (item.job_type?.S === 'multi_day_consulting') {
            if (item.dates?.SS) job.dates = item.dates.SS;
            if (item.start_time?.S) job.startTime = item.start_time.S;
            if (item.end_time?.S) job.endTime = item.end_time.S;
          } else if (item.job_type?.S === 'permanent') {
            if (item.start_date?.S) job.startDate = item.start_date.S;
          }

          // Location details
          if (item.city?.S) job.city = item.city.S;
          if (item.state?.S) job.state = item.state.S;
          if (item.addressLine1?.S) job.addressLine1 = item.addressLine1.S;
          if (item.addressLine2?.S) job.addressLine2 = item.addressLine2.S;
          if (item.addressLine3?.S) job.addressLine3 = item.addressLine3.S;

          // Coordinates — prefer job-level lat/lng if present (denormalized at
          // write time in newer code paths); otherwise we fall back to the
          // clinic's coords below after fetchClinicInfo.
          const jobLat = toNumber(item.lat);
          const jobLng = toNumber(item.lng);
          if (jobLat != null) job.lat = jobLat;
          if (jobLng != null) job.lng = jobLng;

          // Work-location type — required by the "Onsite / US Remote / Global"
          // frontend filter. Stored as `work_location_type` on the posting.
          if (item.work_location_type?.S) job.workLocationType = item.work_location_type.S;

          // Shift specialty — drives the Specialty row in the expanded card.
          // Tolerates the handful of key variants seen across writers.
          const specialty =
            item.shift_speciality?.S ||
            item.shiftSpeciality?.S ||
            item.shift_specialty?.S ||
            item.shiftSpecialty?.S ||
            item.specialty?.S ||
            item.speciality?.S;
          if (specialty) job.shiftSpeciality = specialty;

          // Skills / required software — array-valued, also tolerant of key drift.
          const requirements = toStringArray(item.requirements);
          if (requirements.length > 0) job.requirements = requirements;

          const software = toStringArray(
            item.clinicSoftware || item.clinic_software || item.softwareRequired || item.software_required
          );
          if (software.length > 0) job.clinicSoftware = software;

          // Parking details
          if (item.parkingType?.S) job.parkingType = item.parkingType.S;
          else if (item.parking_type?.S) job.parkingType = item.parking_type.S;
          if (typeof item.freeParkingAvailable?.BOOL === "boolean") {
            job.freeParkingAvailable = item.freeParkingAvailable.BOOL;
          } else if (typeof item.free_parking_available?.BOOL === "boolean") {
            job.freeParkingAvailable = item.free_parking_available.BOOL;
          }

          // Promotion fields (denormalized on job for fast access)
          if (item.isPromoted?.BOOL) {
            // Check if promotion has expired
            const expiresAt = item.promotionExpiresAt?.S;
            if (expiresAt && new Date(expiresAt) > new Date()) {
              job.isPromoted = true;
              job.promotionId = item.promotionId?.S;
              job.promotionPlanId = item.promotionPlanId?.S;
              job.promotionExpiresAt = expiresAt;
            } else {
              job.isPromoted = false;
            }
          }

          // Enrich with clinic display info (name, contact) from the
          // CLINIC_PROFILES_TABLE.
          const clinicUserSub = item.clinicUserSub?.S;
          if (clinicUserSub) {
            const clinicInfo = await fetchClinicInfo(clinicUserSub);
            if (clinicInfo) {
              job.clinic = clinicInfo;
            }
          }

          // If the job row didn't carry its own lat/lng, resolve coords from
          // the CLINICS_TABLE — with an on-the-fly geocode fallback + writeback
          // so the Near-me filter works for pre-existing clinics that were
          // created before geocoding was wired into createClinic.
          if (job.lat == null || job.lng == null) {
            const jobClinicId = item.clinicId?.S || "";
            if (jobClinicId) {
              const coords = await resolveClinicCoords(jobClinicId);
              if (coords.lat != null) job.lat = coords.lat;
              if (coords.lng != null) job.lng = coords.lng;
            }
          }

          jobPostings.push(job);
        }
      }

      ExclusiveStartKey = scanResponse.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // LinkedIn-style sorting: promoted jobs first (by tier weight), then by recency
    const promoWeight: Record<string, number> = { premium: 3, featured: 2, basic: 1 };
    jobPostings.sort((a, b) => {
      const wa = a.isPromoted ? (promoWeight[a.promotionPlanId || ""] || 1) : 0;
      const wb = b.isPromoted ? (promoWeight[b.promotionPlanId || ""] || 1) : 0;
      if (wa !== wb) return wb - wa; // Higher tier promoted jobs first
      const ta = new Date(a.createdAt).getTime() || 0;
      const tb = new Date(b.createdAt).getTime() || 0;
      return tb - ta; // Then newest first
    });

    for (const j of jobPostings) {
      if (j.isPromoted && j.promotionId) {
        fireAndForgetIncrement(j.jobId, j.promotionId, "impressions");
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        jobPostings,
        totalCount: jobPostings.length,
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving active job postings:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: `Failed to retrieve active job postings: ${error.message || "unknown"}`,
      }),
    };
  }
};