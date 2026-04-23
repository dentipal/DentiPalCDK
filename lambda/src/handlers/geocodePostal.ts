import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { LocationClient, SearchPlaceIndexForTextCommand } from "@aws-sdk/client-location";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION: string = process.env.REGION || "us-east-1";
const PLACE_INDEX_NAME: string | undefined = process.env.PLACE_INDEX_NAME;
const locationClient = new LocationClient({ region: REGION });

const json = (statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body),
});

// AWS Location's FilterCountries expects ISO 3166-1 alpha-3 codes (e.g. "USA").
// The frontend sends alpha-2 ("US") or full names ("United States"); normalize here.
const ISO2_TO_ISO3: Record<string, string> = {
    US: "USA", IN: "IND", GB: "GBR", UK: "GBR", CA: "CAN", AU: "AUS",
    DE: "DEU", FR: "FRA", NL: "NLD", IE: "IRL", NZ: "NZL", SG: "SGP",
    JP: "JPN", CN: "CHN", BR: "BRA", MX: "MEX", ZA: "ZAF", AE: "ARE",
    SA: "SAU", KR: "KOR", IT: "ITA", ES: "ESP", PT: "PRT", SE: "SWE",
    NO: "NOR", FI: "FIN", DK: "DNK", CH: "CHE", AT: "AUT", BE: "BEL",
    PL: "POL", TR: "TUR", ID: "IDN", PH: "PHL", MY: "MYS", TH: "THA",
    VN: "VNM",
};

const NAME_TO_ISO3: Record<string, string> = {
    "united states": "USA", "usa": "USA",
    "india": "IND",
    "united kingdom": "GBR", "uk": "GBR", "great britain": "GBR", "england": "GBR",
    "canada": "CAN",
    "australia": "AUS",
    "germany": "DEU",
    "france": "FRA",
    "netherlands": "NLD",
    "ireland": "IRL",
    "new zealand": "NZL",
    "singapore": "SGP",
    "japan": "JPN",
};

const normalizeCountry = (raw: string | undefined): string => {
    const v = (raw || "").trim();
    if (!v) return "USA";
    const upper = v.toUpperCase();
    if (upper.length === 3) return upper;
    if (upper.length === 2 && ISO2_TO_ISO3[upper]) return ISO2_TO_ISO3[upper];
    return NAME_TO_ISO3[v.toLowerCase()] || "USA";
};

// US state full-name -> 2-letter abbreviation (for HERE data which returns full names).
const US_STATE_ABBR: Record<string, string> = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
    indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
    wyoming: "WY", "puerto rico": "PR",
};

const deriveStateAbbr = (region: string | undefined, country: string): string => {
    if (!region) return "";
    if (region.length <= 3) return region.toUpperCase();
    if (country === "USA") {
        const abbr = US_STATE_ABBR[region.toLowerCase()];
        if (abbr) return abbr;
    }
    return "";
};

// GET /location/lookup?postalCode=90210&country=us&limit=10
// Response: { places: NormalizedAddress[] } matching dentipal/src/utils/awsLocation.ts
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    const method = (event.requestContext as any).http?.method || event.httpMethod || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    if (!PLACE_INDEX_NAME) {
        console.error("[location/lookup] PLACE_INDEX_NAME env var is not set");
        return json(500, { places: [], error: "Geocoding is not configured." });
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader) throw new Error("Authorization header is missing");
        extractUserFromBearerToken(authHeader);
    } catch (authError: any) {
        return json(401, { places: [], error: authError?.message || "Unauthorized" });
    }

    const params = event.queryStringParameters || {};
    const postal = (params.postalCode || params.postal || "").trim();
    const country = normalizeCountry(params.country);
    const rawLimit = Number(params.limit || 10);
    const maxResults = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 20) : 10;

    if (!postal) {
        return json(400, { places: [], error: "Query param 'postalCode' is required." });
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9\s\-]{1,11}$/.test(postal)) {
        return json(400, { places: [], error: "Invalid postal code format." });
    }

    try {
        const resp = await locationClient.send(new SearchPlaceIndexForTextCommand({
            IndexName: PLACE_INDEX_NAME,
            Text: postal,
            FilterCountries: [country],
            MaxResults: maxResults,
        }));

        const places = (resp.Results || [])
            .map((r) => r.Place)
            .filter((p): p is NonNullable<typeof p> => !!p)
            .map((p) => {
                const state = p.Region || "";
                const placeName = p.Municipality || p.SubRegion || p.Neighborhood || "";
                return {
                    placeName,
                    state,
                    stateAbbreviation: deriveStateAbbr(state, country),
                    country: p.Country || country,
                    municipality: p.Municipality || undefined,
                    postalCode: p.PostalCode || postal,
                    label: p.Label || undefined,
                };
            })
            // Drop rows with no usable locality so the UI doesn't render blanks.
            .filter((place) => place.placeName || place.state);

        return json(200, { places, source: "aws-location" });
    } catch (err: any) {
        console.error("[location/lookup] AWS Location error:", err?.name, err?.message);
        return json(502, { places: [], error: "Geocoding upstream failed. Please try again." });
    }
};
