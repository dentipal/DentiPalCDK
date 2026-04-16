// geo.ts — Zip-code-based geolocation and distance utilities
import * as zipcodes from "zipcodes";

export interface Coordinates {
  lat: number;
  lng: number;
}

/**
 * Look up latitude/longitude for a US zip code.
 * Returns null if the zip code is not found.
 */
export function zipToCoords(zip: string | undefined): Coordinates | null {
  if (!zip) return null;
  // Normalize: strip spaces, take first 5 digits
  const cleaned = zip.trim().replace(/\D/g, "").slice(0, 5);
  if (cleaned.length < 5) return null;

  const result = zipcodes.lookup(cleaned);
  if (!result || result.latitude == null || result.longitude == null) return null;

  return { lat: result.latitude, lng: result.longitude };
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

/**
 * Calculate distance in miles between two zip codes.
 * Returns null if either zip code cannot be resolved.
 */
export function distanceBetweenZips(
  zip1: string | undefined,
  zip2: string | undefined
): number | null {
  const coords1 = zipToCoords(zip1);
  const coords2 = zipToCoords(zip2);
  if (!coords1 || !coords2) return null;

  return haversineDistance(coords1.lat, coords1.lng, coords2.lat, coords2.lng);
}
