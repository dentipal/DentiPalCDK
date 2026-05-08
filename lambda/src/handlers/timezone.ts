// @ts-expect-error tz-lookup ships no types
import tzLookup from "tz-lookup";
import { fromZonedTime } from "date-fns-tz";

const DEFAULT_TZ = "America/New_York";

export function ianaFromCoords(lat: number | undefined | null, lng: number | undefined | null): string {
    if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
        return DEFAULT_TZ;
    }
    try {
        return tzLookup(lat, lng);
    } catch {
        return DEFAULT_TZ;
    }
}

export function computeUtcShiftStart(date: string, startTime: string, timezone: string): Date | null {
    if (!date || !startTime) return null;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(startTime.trim());
    if (!dateMatch || !timeMatch) return null;
    const [, y, m, d] = dateMatch;
    const [, h, min] = timeMatch;
    const hh = h.padStart(2, "0");
    const local = `${y}-${m}-${d}T${hh}:${min}:00`;
    try {
        const utc = fromZonedTime(local, timezone || DEFAULT_TZ);
        return Number.isNaN(utc.getTime()) ? null : utc;
    } catch {
        return null;
    }
}

export { DEFAULT_TZ };
