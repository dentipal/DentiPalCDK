import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  ScanCommandOutput,
  QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

interface ProfessionalProfileItem {
  userSub?: { S?: string };
  dental_software_experience?: any;
  first_name?: { S?: string };
  full_name?: { S?: string };
  last_name?: { S?: string };
  role?: { S?: string };
  /** Written by `ProfessionalProfileFormPage.tsx` (older form). */
  specialties?: any;
  /** Written by the `useSpecializations` hook / `SpecializationsSection` — the
   *  form currently rendered on the Professional profile page. Different column
   *  name, same semantic field. We must read both and merge. */
  specializations?: any;
  years_of_experience?: { N?: string };
}

/**
 * Normalize a DynamoDB attribute that may be stored as SS (String Set),
 * L (List of {S}), or a single S (String), into a plain string[].
 * Older profile rows sometimes write specialties/software as L; if the
 * reader only accepts SS, those values silently disappear and downstream
 * filters match nothing. This helper makes the reader forgiving.
 */
function parseStringArrayAttr(attr: any): string[] {
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

interface AddressItem {
  city?: { S?: string };
  state?: { S?: string };
  pincode?: { S?: string };
  lat?: { N?: string };
  lng?: { N?: string };
}

interface Profile {
  userSub: string;
  dentalSoftwareExperience: string[];
  firstName: string;
  lastName: string;
  role: string;
  specialties: string[];
  yearsOfExperience: number;
  city: string;
  state: string;
  zipcode: string;
  // Coordinates come from UserAddresses, populated on create/update by geocodeAddressParts.
  // Null when the pro's address couldn't be geocoded — client should exclude these from distance filtering.
  lat: number | null;
  lng: number | null;
}

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const scanCommand = new ScanCommand({
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
    });

    const result: ScanCommandOutput = await dynamodb.send(scanCommand);

    const profiles: Profile[] = await Promise.all(
      (result.Items || []).map(async (item) => {
        const professionalItem = item as unknown as ProfessionalProfileItem;
        const userSub = professionalItem.userSub?.S || "";

        let city = "";
        let state = "";
        let zipcode = "";
        let lat: number | null = null;
        let lng: number | null = null;

        // Fetch address for this user
        if (userSub) {
          try {
            const queryCommand = new QueryCommand({
              TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
              KeyConditionExpression: "userSub = :userSub",
              ExpressionAttributeValues: {
                ":userSub": { S: userSub },
              },
            });

            const addressResult: QueryCommandOutput = await dynamodb.send(queryCommand);
            const addressItem = (addressResult.Items?.[0] || {}) as unknown as AddressItem;

            city = addressItem.city?.S || "";
            state = addressItem.state?.S || "";
            zipcode = addressItem.pincode?.S || "";
            // lat/lng are stored as DynamoDB Number attributes; parse to float or leave null.
            if (addressItem.lat?.N) {
              const v = parseFloat(addressItem.lat.N);
              if (Number.isFinite(v)) lat = v;
            }
            if (addressItem.lng?.N) {
              const v = parseFloat(addressItem.lng.N);
              if (Number.isFinite(v)) lng = v;
            }
          } catch (addrError) {
            console.warn(`Failed to fetch address for userSub: ${userSub}`, addrError);
          }
        }

        // Merge `specialties` + `specializations` — two profile forms write to
        // different column names (see the ProfessionalProfileItem comment).
        // Dedupe case-insensitively so the Find Professionals filter always sees
        // something regardless of which form the pro used.
        const mergedSpecialties = (() => {
          const all = [
            ...parseStringArrayAttr(professionalItem.specialties),
            ...parseStringArrayAttr(professionalItem.specializations),
          ];
          const seen = new Set<string>();
          const out: string[] = [];
          for (const s of all) {
            const key = s.trim().toLowerCase();
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(s.trim());
          }
          return out;
        })();

        return {
          userSub,
          // Accept SS, L, or S storage shapes — see parseStringArrayAttr for why.
          dentalSoftwareExperience: parseStringArrayAttr(professionalItem.dental_software_experience),
          firstName: professionalItem.first_name?.S || professionalItem.full_name?.S || "",
          lastName: professionalItem.last_name?.S || "",
          role: professionalItem.role?.S || "",
          specialties: mergedSpecialties,
          yearsOfExperience: professionalItem.years_of_experience?.N
            ? parseInt(professionalItem.years_of_experience.N)
            : 0,
          city,
          state,
          zipcode,
          lat,
          lng,
        };
      })
    );

    return json(200, {
      success: true,
      message: "Professional profiles with address details (city, state, pincode) retrieved successfully",
      profiles,
      count: profiles.length,
    });

  } catch (error: any) {
    console.error("Error fetching professional profiles:", error);

    return json(500, {
      success: false,
      message: "Error fetching professional profiles",
      error: error.message,
    });
  }
};