import {
  DynamoDBClient,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

// Helper layer used by the job-feed ranker to read the soft-signal slice of
// the pro's profile — things the pro has already told us they care about
// (role, specialties, travel preference, skills/certs) so we can rank
// without making them re-type the same values into the filter bar.
//
// Read on every /professionals/filtered-jobs request, alongside the
// availability and address lookups. None of these fields hard-exclude jobs;
// they tilt the relevance score.
//
// Storage on PROFESSIONAL_PROFILES_TABLE (created by createProfessionalProfile
// at L141-170 — dynamic field spread, so attributes only exist when the pro
// supplied them):
//   - role:                  S    (canonical role enum)
//   - specialties:           SS   (sub-role expertise, e.g. ["pediatric"])
//   - skills:                SS   (free-text skill keywords)
//   - certificates:          SS   (free-text cert keywords)
//   - is_willing_to_travel:  BOOL (soft travel preference)
//   - max_travel_distance:   N    (miles the pro is willing to travel)

const REGION = process.env.REGION || "us-east-1";
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "";

const ddb = new DynamoDBClient({ region: REGION });

export interface ProfessionalPreferences {
  role: string | null;
  specialties: string[];
  skills: string[];
  certificates: string[];
  isWillingToTravel: boolean;
  // Miles the pro is willing to travel. Null when unset — callers decide a
  // default (the ranker uses 25mi as the scoring scale fallback).
  maxTravelDistance: number | null;
}

// Default favours visibility: no role bias, no skill bias, willing to travel,
// no soft distance cap. A pro with an empty profile still sees the full feed.
export const DEFAULT_PREFERENCES: ProfessionalPreferences = {
  role: null,
  specialties: [],
  skills: [],
  certificates: [],
  isWillingToTravel: true,
  maxTravelDistance: null,
};

function readStringSet(attr: AttributeValue | undefined): string[] {
  if (!attr) return [];
  if (Array.isArray(attr.SS)) {
    return attr.SS.filter((s): s is string => typeof s === "string" && s.trim() !== "");
  }
  // Forward-compat: tolerate L-of-S in case anything starts writing this shape.
  if (Array.isArray(attr.L)) {
    return attr.L
      .map((v) => (v && typeof v.S === "string" ? v.S : null))
      .filter((v): v is string => v !== null && v.trim() !== "");
  }
  return [];
}

/**
 * Read preference fields off an already-fetched profile row. Lets other
 * handlers that scan the profile for their own reason skip a second
 * round-trip — same idiom as readAvailabilityFromProfileItem.
 */
export function readPreferencesFromProfileItem(
  item: Record<string, AttributeValue> | undefined | null,
): ProfessionalPreferences {
  if (!item) return DEFAULT_PREFERENCES;

  const role = typeof item.role?.S === "string" && item.role.S.trim() !== "" ? item.role.S : null;
  const specialties = readStringSet(item.specialties);
  const skills = readStringSet(item.skills);
  const certificates = readStringSet(item.certificates);

  // Default true: legacy profiles predate this field and a pro who hasn't
  // declared a preference should not be silently penalised for travel.
  const isWillingToTravel =
    typeof item.is_willing_to_travel?.BOOL === "boolean"
      ? item.is_willing_to_travel.BOOL
      : true;

  let maxTravelDistance: number | null = null;
  if (typeof item.max_travel_distance?.N === "string") {
    const parsed = parseFloat(item.max_travel_distance.N);
    if (Number.isFinite(parsed) && parsed > 0) maxTravelDistance = parsed;
  }

  return { role, specialties, skills, certificates, isWillingToTravel, maxTravelDistance };
}

/**
 * Look up the pro's preference slice by userSub. Returns DEFAULT_PREFERENCES
 * on any miss or error so a transient DDB issue degrades ranking gracefully
 * to "no personalization" instead of erroring the whole feed.
 */
export async function getProfessionalPreferences(
  userSub: string,
): Promise<ProfessionalPreferences> {
  if (!userSub || !PROFESSIONAL_PROFILES_TABLE) return DEFAULT_PREFERENCES;
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: PROFESSIONAL_PROFILES_TABLE,
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression:
          "#r, specialties, skills, certificates, is_willing_to_travel, max_travel_distance",
        // `role` is a reserved word in DynamoDB expressions.
        ExpressionAttributeNames: { "#r": "role" },
        Limit: 1,
      }),
    );
    return readPreferencesFromProfileItem(resp.Items?.[0]);
  } catch (err) {
    console.warn(
      `[preferences] Failed to read preferences for ${userSub}; falling back to defaults:`,
      (err as Error).message,
    );
    return DEFAULT_PREFERENCES;
  }
}
