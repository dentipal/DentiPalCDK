// geocodePostal.ts — Look up city/state/country for a postal code using
// Amazon Location Service (replaces the public Zippopotam.us dependency).
//
// Route: GET /geocode/postal?country=<ISO2>&postalCode=<code>
// Returns: { city, state, stateAbbreviation, country, postalCode, label, coordinates }

import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
} from "@aws-sdk/client-location";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME || "DentiPalGeocoder";

const locClient = new LocationClient({ region: REGION });

// Amazon Location Service's `FilterCountries` parameter expects ISO 3166-1
// alpha-3 codes, but users / clients commonly deal in alpha-2. This map
// covers every country listed in the frontend's Country dropdown.
const ISO2_TO_ISO3: Record<string, string> = {
  US: "USA",
  CA: "CAN",
  GB: "GBR",
  IN: "IND",
  AU: "AUS",
  DE: "DEU",
  FR: "FRA",
  ES: "ESP",
  IT: "ITA",
  NL: "NLD",
  BR: "BRA",
  MX: "MEX",
  JP: "JPN",
  CH: "CHE",
  SE: "SWE",
  NO: "NOR",
  DK: "DNK",
  FI: "FIN",
  BE: "BEL",
  AT: "AUT",
  PL: "POL",
  PT: "PRT",
  NZ: "NZL",
};

// Best-effort map US state names → 2-letter abbreviation so the form shows
// "SC" (what US users expect) rather than "South Carolina". Location Service's
// `Region` field returns the full name.
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
  "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
  wyoming: "WY", "district of columbia": "DC",
};

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "{}" };
  }

  const params = event.queryStringParameters || {};
  const postalCode = (params.postalCode || params.postal_code || "").trim();
  const countryRaw = (params.country || "").trim().toUpperCase();

  if (!postalCode) {
    return json(400, {
      error: "Bad Request",
      message: "postalCode query parameter is required",
    });
  }
  if (postalCode.length > 12) {
    return json(400, {
      error: "Bad Request",
      message: "postalCode is too long",
    });
  }

  // If a country is provided we narrow the search; if not, we let Location
  // Service figure it out (useful when the frontend hasn't chosen yet).
  const iso3 = countryRaw ? ISO2_TO_ISO3[countryRaw] : undefined;

  try {
    const resp = await locClient.send(
      new SearchPlaceIndexForTextCommand({
        IndexName: PLACE_INDEX_NAME,
        Text: postalCode,
        MaxResults: 1,
        // Only filter when we know the ISO3 — otherwise we'd reject countries
        // outside our map even if the user typed a valid code.
        ...(iso3 ? { FilterCountries: [iso3] } : {}),
      })
    );

    const place = resp.Results?.[0]?.Place;
    if (!place) {
      return json(404, {
        error: "Not Found",
        message: "No location found for that postal code",
      });
    }

    const city = place.Municipality || place.SubRegion || "";
    const regionFull = place.Region || "";
    const stateAbbr =
      countryRaw === "US"
        ? US_STATE_ABBR[regionFull.toLowerCase()] || regionFull
        : regionFull;

    const point = place.Geometry?.Point;
    const coordinates =
      point && point.length === 2
        ? { lng: point[0], lat: point[1] }
        : null;

    return json(200, {
      status: "success",
      data: {
        city,
        state: stateAbbr,
        stateFull: regionFull,
        country: place.Country || iso3 || countryRaw || "",
        postalCode: place.PostalCode || postalCode,
        label: place.Label || "",
        coordinates,
      },
    });
  } catch (err) {
    const error = err as Error;
    console.error("[geocodePostal] Error:", error.name, error.message);
    return json(500, {
      error: "Internal Server Error",
      message: "Failed to look up postal code",
    });
  }
};
