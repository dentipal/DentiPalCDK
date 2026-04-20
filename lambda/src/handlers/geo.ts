// geo.ts — Global geocoding via Amazon Location Service + Haversine distance
import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
} from "@aws-sdk/client-location";

const REGION = process.env.REGION || "us-east-1";
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME || "DentiPalGeocoder";

const locClient = new LocationClient({ region: REGION });

export interface Coordinates {
  lat: number;
  lng: number;
}

export interface AddressParts {
  addressLine1?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
}

/**
 * Build a single-line address string from parts.
 * Returns null if not enough info to geocode.
 */
export function buildAddressString(parts: AddressParts): string | null {
  const pieces = [
    parts.addressLine1,
    parts.city,
    parts.state,
    parts.pincode,
    parts.country,
  ].filter((p) => p && String(p).trim().length > 0);

  if (pieces.length < 2) return null; // need at least 2 parts for a reasonable geocode
  return pieces.join(", ");
}

/**
 * Geocode a free-form address to coordinates using Amazon Location Service.
 * Works globally. Returns null if the address cannot be resolved.
 */
export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  const trimmed = address?.trim();
  if (!trimmed) return null;

  try {
    const resp = await locClient.send(
      new SearchPlaceIndexForTextCommand({
        IndexName: PLACE_INDEX_NAME,
        Text: trimmed,
        MaxResults: 1,
      })
    );

    const result = resp.Results?.[0];
    const point = result?.Place?.Geometry?.Point;
    if (!point || point.length !== 2) return null;

    // Amazon Location returns [longitude, latitude]
    const [lng, lat] = point;
    if (typeof lat !== "number" || typeof lng !== "number") return null;

    return { lat, lng };
  } catch (err) {
    console.error("[geocodeAddress] Error:", err);
    return null;
  }
}

/**
 * Convenience: geocode an address given as structured parts.
 */
export async function geocodeAddressParts(parts: AddressParts): Promise<Coordinates | null> {
  const addr = buildAddressString(parts);
  if (!addr) return null;
  return geocodeAddress(addr);
}

/**
 * Calculate the distance in miles between two lat/lng points
 * using the Haversine formula (accounts for Earth's curvature).
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3959; // Earth's radius in miles
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
