import { DynamoDBClient, QueryCommand, GetItemCommand, type AttributeValue, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { geocodeAddressParts, Coordinates } from "../geo";
import type { AgentType } from "./sessionStore";

const REGION = process.env.REGION || "us-east-1";
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-V5-ProfessionalProfiles";
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE || "DentiPal-V5-UserAddresses";
const USER_CLINIC_ASSIGNMENTS_TABLE = process.env.USER_CLINIC_ASSIGNMENTS_TABLE || "DentiPal-V5-UserClinicAssignments";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-V5-Clinics";

const ddb = new DynamoDBClient({ region: REGION });

export interface HomeCoordinates extends Coordinates {
  city?: string;
  state?: string;
  pincode?: string;
}

export interface ProfessionalContext {
  agentType: "professional";
  userSub: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  specialties?: string[];
  home?: HomeCoordinates;
}

export interface ClinicContext {
  agentType: "clinic";
  userSub: string;
  firstName?: string;
  lastName?: string;
  clinics: Array<{
    clinicId: string;
    name?: string;
    city?: string;
    state?: string;
    role?: string;
  }>;
}

export type UserContext = ProfessionalContext | ClinicContext;

const S = (a: any): string | undefined => (a && typeof a.S === "string" ? a.S : undefined);
const SS = (a: any): string[] | undefined =>
  Array.isArray(a?.SS) ? a.SS : Array.isArray(a?.L) ? a.L.map(S).filter(Boolean) as string[] : undefined;

/**
 * One-shot fetch of everything the agent needs to know about the caller. Run
 * once at session bootstrap; cached on `ChatConnections.slotBuffer.userContext`
 * for the 15-min session TTL.
 *
 * Errors are tolerated: a missing profile row or an un-geocodable address
 * downgrades the context but never blocks the session.
 */
export async function fetchUserContext(userSub: string, agentType: AgentType): Promise<UserContext | null> {
  if (agentType === "public") return null;

  if (agentType === "professional") {
    return await fetchProfessionalContext(userSub);
  }
  return await fetchClinicContext(userSub);
}

async function fetchProfessionalContext(userSub: string): Promise<ProfessionalContext> {
  const ctx: ProfessionalContext = { agentType: "professional", userSub };

  // Profile + address fetched in parallel.
  const [profile, address] = await Promise.all([
    safeGet(PROFESSIONAL_PROFILES_TABLE, { userSub: { S: userSub } }),
    safeGet(USER_ADDRESSES_TABLE, { userSub: { S: userSub } }),
  ]);

  if (profile) {
    ctx.firstName = S(profile.first_name);
    ctx.lastName = S(profile.last_name);
    ctx.role = S(profile.role);
    ctx.specialties = SS(profile.specialties);
  }

  if (address) {
    const parts = {
      addressLine1: S(address.addressLine1) || "",
      city: S(address.city),
      state: S(address.state),
      pincode: S(address.pincode),
      country: S(address.country) || "USA",
    };
    if (parts.city && parts.state) {
      const coords = await geocodeAddressParts(parts).catch(() => null);
      if (coords) {
        ctx.home = { ...coords, city: parts.city, state: parts.state, pincode: parts.pincode };
      }
    }
  }

  return ctx;
}

async function fetchClinicContext(userSub: string): Promise<ClinicContext> {
  const ctx: ClinicContext = { agentType: "clinic", userSub, clinics: [] };

  // Clinic admins may or may not have a row in ProfessionalProfiles. Read
  // best-effort for first/last name; tolerate absence.
  const profile = await safeGet(PROFESSIONAL_PROFILES_TABLE, { userSub: { S: userSub } });
  if (profile) {
    ctx.firstName = S(profile.first_name);
    ctx.lastName = S(profile.last_name);
  }

  // 1. Find clinic assignments for this user. Paginate via LastEvaluatedKey —
  //    a hard `Limit: 25` here silently truncated the chatbot's view of a
  //    user's clinics, so users with more than 25 assignments only saw the
  //    first page.
  const assignmentRows: Array<Record<string, any>> = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
  try {
    do {
      const res: QueryCommandOutput = await ddb.send(new QueryCommand({
        TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
        KeyConditionExpression: "userSub = :u",
        ExpressionAttributeValues: { ":u": { S: userSub } },
        ExclusiveStartKey,
      }));
      if (res.Items?.length) assignmentRows.push(...res.Items);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  } catch (e) {
    console.warn("[userContext] failed to fetch assignments", e);
  }

  // 2. For each, batch-resolve clinic name/city/state from the Clinics table.
  const clinics = await Promise.all(
    assignmentRows.map(async (row) => {
      const clinicId = S(row.clinicId);
      if (!clinicId) return null;
      const clinicRow = await safeGet(CLINICS_TABLE, { clinicId: { S: clinicId } });
      return {
        clinicId,
        name: S(clinicRow?.name) || S(clinicRow?.clinic_name),
        city: S(clinicRow?.city),
        state: S(clinicRow?.state),
        role: S(row.role),
      };
    }),
  );
  ctx.clinics = clinics.filter((c): c is NonNullable<typeof c> => c !== null);

  return ctx;
}

async function safeGet(
  tableName: string,
  key: Record<string, any>,
): Promise<Record<string, any> | null> {
  try {
    const res = await ddb.send(new GetItemCommand({ TableName: tableName, Key: key }));
    return res.Item || null;
  } catch (e) {
    console.warn(`[userContext] GetItem ${tableName} failed`, e);
    return null;
  }
}
