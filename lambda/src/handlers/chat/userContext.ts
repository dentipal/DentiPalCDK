import { DynamoDBClient, QueryCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
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

  // 1. Find clinic assignments for this user.
  let assignmentRows: Array<Record<string, any>> = [];
  try {
    const res = await ddb.send(new QueryCommand({
      TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
      KeyConditionExpression: "userSub = :u",
      ExpressionAttributeValues: { ":u": { S: userSub } },
      Limit: 25,
    }));
    assignmentRows = res.Items || [];
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

function displayNameOf(ctx: UserContext): string {
  return (ctx.firstName || ctx.lastName)
    ? [ctx.firstName, ctx.lastName].filter(Boolean).join(" ")
    : "this user";
}

/**
 * Hard role guardrail. Must be re-injected on every fresh agent session
 * because role drift is a behavior bug (not a fact the agent should "remember
 * and apply") — we want it loaded deterministically before the first user
 * message of every session.
 */
function renderRoleAnchor(ctx: UserContext): string {
  const displayName = displayNameOf(ctx);
  if (ctx.agentType === "professional") {
    return [
      `[ROLE ANCHOR — ground every response in this. Never drift.]`,
      `You are talking to ${displayName}. They are a PROFESSIONAL on the DentiPal platform — a dental hygienist / dentist / assistant looking for work.`,
      `NEVER reference clinic-side concepts (posting jobs, hiring, applicants, "your clinic"). If they ask about something only a clinic can do, respond plainly: "That's a clinic-side action — you'd need to be signed in as a clinic admin."`,
      `[END ROLE ANCHOR]`,
    ].join("\n");
  }
  return [
    `[ROLE ANCHOR — ground every response in this. Never drift.]`,
    `You are talking to ${displayName}. They are a CLINIC ADMIN on the DentiPal platform — staff at a dental clinic posting jobs and managing applicants.`,
    `NEVER reference professional-side concepts (applying to jobs, "your shifts", "the clinic invited me"). If they ask about something only a professional can do, respond plainly: "That's a professional-side action — you'd need to be signed in as a dental professional."`,
    `[END ROLE ANCHOR]`,
  ].join("\n");
}

/**
 * Per-user profile/clinic snapshot. Injected once per 15-min Bedrock Agents
 * session — after that Bedrock holds it in its own session memory keyed by
 * bedrockSessionId.
 */
function renderProfileContext(ctx: UserContext): string {
  const displayName = displayNameOf(ctx);

  if (ctx.agentType === "professional") {
    const lines: string[] = [
      `[USER CONTEXT — do not echo verbatim; use silently to ground your answers]`,
      `userSub: ${ctx.userSub}`,
    ];
    if (ctx.firstName || ctx.lastName) lines.push(`name: ${displayName}`);
    // NOTE: do NOT mention the user's role here. The agent kept grabbing it
    // and passing as a filter to search_jobs_near_me — narrowing results.
    // The handler already shows jobs relevant to the user's role.
    if (ctx.specialties?.length) lines.push(`specialties: ${ctx.specialties.join(", ")}`);
    if (ctx.home) {
      lines.push(`home: ${[ctx.home.city, ctx.home.state].filter(Boolean).join(", ")} (lat=${ctx.home.lat.toFixed(4)}, lng=${ctx.home.lng.toFixed(4)})`);
      lines.push(`When the user asks for jobs "near me", pass radiusMiles=50 to search_jobs_near_me; the server applies the distance filter using the lat/lng above.`);
    } else {
      lines.push(`home: not on file. Tell the user they need to add a home address before nearby-job filtering works.`);
    }
    lines.push(`[END USER CONTEXT]`);
    return lines.join("\n");
  }

  // clinic
  const lines: string[] = [
    `[USER CONTEXT — do not echo verbatim; use silently to ground your answers]`,
    `userSub: ${ctx.userSub}`,
    ctx.firstName || ctx.lastName ? `name: ${displayName}` : "",
    `manages_clinics:`,
  ].filter(Boolean);
  if (ctx.clinics.length === 0) {
    lines.push(`  (none — get_my_clinics will return empty; user may need to set up a clinic first)`);
  } else {
    for (const c of ctx.clinics) {
      lines.push(`  - ${c.clinicId} | ${c.name || "(unnamed)"} | ${[c.city, c.state].filter(Boolean).join(", ")} | role=${c.role || "n/a"}`);
    }
    if (ctx.clinics.length === 1) {
      lines.push(`The user manages exactly one clinic — auto-pass clinicIds=["${ctx.clinics[0].clinicId}"] for job-post tools without re-asking.`);
    } else {
      lines.push(`The user manages multiple clinics. When posting jobs, ask which clinic(s) by name unless they already specified.`);
    }
  }
  lines.push(`[END USER CONTEXT]`);
  return lines.join("\n");
}

/**
 * Compose role anchor + profile context into a single preamble injected
 * into the first user turn of each session. Memory preamble (AgentCore
 * cross-session summary/preferences) is prepended separately by chatMessage.ts.
 */
export function renderContextPreamble(ctx: UserContext): string {
  return `${renderRoleAnchor(ctx)}\n\n${renderProfileContext(ctx)}`;
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
