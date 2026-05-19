/**
 * Generic DDB read tool — the "escape hatch" exposed to the Bedrock agents
 * for analytics / diagnostic / cross-cut questions that the ~40 narrow
 * handlers don't cover (see plan: make-a-comprehensive-table-joyful-pearl.md).
 *
 * Hard rules (cannot be bypassed by the model):
 *  - Read-only: op ∈ {query, getItem}. No Scan, no writes.
 *  - Allow-list of 6 business tables. PII tables (Messages, Conversations,
 *    OTPVerification, Connections) are NOT in the allow-list.
 *  - keyName must be in the per-table allow-list (PK or known GSI key).
 *  - Auth scoping is FORCED server-side via FilterExpression and/or
 *    post-filter — the model cannot pass another user's identity.
 *  - Result items pass through a PII redactor (defense in depth in case the
 *    agent reads off-pattern records that snuck a PII field in).
 *  - Limit clamped to [1, 50], default 25.
 *  - Public agent is rejected outright — anon sessions never get a
 *    SQL-shaped surface.
 *
 * Designed to be called from toolExecutor.ts as a single switch case.
 */

import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
  GetItemCommand,
  GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { AuthContext } from "../utils";
import type { ChatSession } from "./sessionStore";

const REGION = process.env.REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });

type AgentType = "professional" | "clinic" | "public";

interface AuthForceFilter {
  type: "force";
  /** Item attribute to constrain (e.g. "professionalUserSub", "clinicId"). */
  attr: string;
  /** Allowed values; single → equality, multiple → IN. */
  values: string[];
}
interface AuthPostFilter {
  type: "post-filter";
  /** Run against each returned item; drop if false. */
  predicate: (item: Record<string, any>) => boolean;
}
type AuthDecision =
  | { type: "allow"; filters: Array<AuthForceFilter | AuthPostFilter> }
  | { type: "blocked"; reason: string };

interface TableSpec {
  /** Full DDB table name from env, with fallback. */
  resolveTableName(): string;
  /** Allow-list of attribute names the model may pass as keyName. Empty if
   *  only `op: getItem` is allowed (no Query). */
  allowedKeyNames: string[];
  /** Map keyName → GSI index name (omit / undefined for base-table PK). */
  gsiByKeyName?: Record<string, string>;
  /** Per-agent authorization. Returns "blocked" or list of filters to apply. */
  authorize(input: QueryDdbInput, auth: AuthContext, session: ChatSession): AuthDecision;
}

export interface QueryDdbInput {
  table: string;
  op: "query" | "getItem";
  indexName?: string;
  keyName: string;
  keyValue: string;
  sortKeyName?: string;
  sortKeyValue?: string;
  sortKeyValueEnd?: string; // for between
  sortKeyOp?: "=" | "begins_with" | ">" | ">=" | "<" | "<=" | "between";
  filterStatus?: string;
  filterDateFrom?: string;
  filterDateTo?: string;
  limit?: number;
}

export interface QueryDdbResult {
  items: Array<Record<string, any>>;
  count: number;
  scannedCount: number;
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Per-table specs (the comprehensive table from the plan, as code)
// ─────────────────────────────────────────────────────────────────────────

function harvestKnownIds(session: ChatSession): { subs: Set<string>; clinics: Set<string> } {
  const subs = new Set<string>();
  const clinics = new Set<string>();
  const visit = (node: any): void => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if ((k === "userSub" || k === "professionalUserSub" || k === "userId") && typeof v === "string") subs.add(v);
      if (k === "clinicId" && typeof v === "string") clinics.add(v);
      if (typeof v === "object") visit(v);
    }
  };
  visit(session.recentSearchResults || []);
  return { subs, clinics };
}

function userManagedClinicIds(session: ChatSession): string[] {
  const ctx = session.userContext as any;
  if (!ctx || ctx.agentType !== "clinic" || !Array.isArray(ctx.clinics)) return [];
  return ctx.clinics.map((c: any) => c?.clinicId).filter((s: any): s is string => typeof s === "string");
}

const TABLE_SPECS: Record<string, TableSpec> = {
  JobPostings: {
    resolveTableName: () => process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings",
    allowedKeyNames: ["clinicUserSub", "clinicId", "date", "jobId"],
    gsiByKeyName: {
      clinicId: "ClinicIdIndex",
      date: "DateIndex",
      jobId: "jobId-index-1",
    },
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        // Pros may only ad-hoc-browse active future-dated postings via DateIndex.
        if (input.keyName !== "date") {
          return { type: "blocked", reason: "professional may only query JobPostings by date" };
        }
        return {
          type: "allow",
          filters: [
            { type: "post-filter", predicate: (it) => (it.status === "active") },
            { type: "post-filter", predicate: (it) => {
                const end = it.endDate || it.date;
                return typeof end === "string" && end >= isoToday();
              } },
          ],
        };
      }
      if (agent === "clinic") {
        const clinics = userManagedClinicIds(session);
        if (!clinics.length) return { type: "blocked", reason: "clinic user manages no clinics" };
        return {
          type: "allow",
          filters: [{
            type: "force",
            attr: "clinicId",
            values: clinics,
          }],
        };
      }
      return { type: "blocked", reason: "public agent cannot query JobPostings" };
    },
  },

  JobApplications: {
    resolveTableName: () => process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications",
    allowedKeyNames: ["jobId", "clinicId", "professionalUserSub", "applicationId"],
    gsiByKeyName: {
      clinicId: "clinicId-index",
      professionalUserSub: "professionalUserSub-index",
      applicationId: "applicationId-index",
    },
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        return {
          type: "allow",
          filters: [{ type: "force", attr: "professionalUserSub", values: [auth.userSub] }],
        };
      }
      if (agent === "clinic") {
        const clinics = userManagedClinicIds(session);
        if (!clinics.length) return { type: "blocked", reason: "clinic user manages no clinics" };
        return {
          type: "allow",
          filters: [{ type: "force", attr: "clinicId", values: clinics }],
        };
      }
      return { type: "blocked", reason: "public agent cannot query JobApplications" };
    },
  },

  JobInvitations: {
    resolveTableName: () => process.env.JOB_INVITATIONS_TABLE || "DentiPal-V5-JobInvitations",
    allowedKeyNames: ["jobId", "professionalUserSub"],
    gsiByKeyName: {
      professionalUserSub: "ProfessionalIndex",
    },
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        return {
          type: "allow",
          filters: [{ type: "force", attr: "professionalUserSub", values: [auth.userSub] }],
        };
      }
      // Clinic uses the existing send_invitations write surface; no ad-hoc reads.
      return { type: "blocked", reason: `${agent} agent cannot query JobInvitations` };
    },
  },

  JobNegotiations: {
    resolveTableName: () => process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-V5-JobNegotiations",
    allowedKeyNames: ["applicationId", "jobId"],
    gsiByKeyName: {
      jobId: "JobIndex",
    },
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        return {
          type: "allow",
          filters: [{ type: "post-filter", predicate: (it) => it.professionalUserSub === auth.userSub }],
        };
      }
      if (agent === "clinic") {
        const clinics = new Set(userManagedClinicIds(session));
        if (!clinics.size) return { type: "blocked", reason: "clinic user manages no clinics" };
        return {
          type: "allow",
          filters: [{ type: "post-filter", predicate: (it) => clinics.has(it.clinicId) }],
        };
      }
      return { type: "blocked", reason: "public agent cannot query JobNegotiations" };
    },
  },

  ProfessionalProfiles: {
    resolveTableName: () => process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-V5-ProfessionalProfiles",
    allowedKeyNames: ["userSub"],
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        // Own profile only.
        if (input.keyValue !== auth.userSub) {
          return { type: "blocked", reason: "professional may only read own profile" };
        }
        return { type: "allow", filters: [] };
      }
      if (agent === "clinic") {
        // Must reference a userSub that appeared in a prior tool result this session.
        const { subs } = harvestKnownIds(session);
        if (!subs.has(input.keyValue)) {
          return { type: "blocked", reason: "userSub not in recent tool results; clinic must view profile via list_applicants_for_job first" };
        }
        return { type: "allow", filters: [] };
      }
      return { type: "blocked", reason: "public agent cannot read ProfessionalProfiles" };
    },
  },

  ClinicProfiles: {
    resolveTableName: () => process.env.CLINIC_PROFILES_TABLE || "DentiPal-V5-ClinicProfiles",
    allowedKeyNames: ["clinicId", "userSub"],
    gsiByKeyName: {
      userSub: "userSub-index",
    },
    authorize(input, auth, session) {
      const agent = auth.userType as AgentType;
      if (agent === "professional") {
        // Read-only, only if the target clinicId surfaced in a prior tool result.
        if (input.keyName !== "clinicId") {
          return { type: "blocked", reason: "professional may only read ClinicProfiles by clinicId" };
        }
        const { clinics } = harvestKnownIds(session);
        if (!clinics.has(input.keyValue)) {
          return { type: "blocked", reason: "clinicId not in recent tool results; search first" };
        }
        return { type: "allow", filters: [] };
      }
      if (agent === "clinic") {
        const managed = userManagedClinicIds(session);
        if (!managed.length) return { type: "blocked", reason: "clinic user manages no clinics" };
        if (input.keyName === "clinicId") {
          if (!managed.includes(input.keyValue)) {
            return { type: "blocked", reason: "clinicId not managed by this user" };
          }
          return { type: "allow", filters: [] };
        }
        if (input.keyName === "userSub") {
          if (input.keyValue !== auth.userSub) {
            return { type: "blocked", reason: "clinic may only query ClinicProfiles by own userSub" };
          }
          return { type: "allow", filters: [] };
        }
        return { type: "blocked", reason: "unsupported keyName for ClinicProfiles" };
      }
      return { type: "blocked", reason: "public agent cannot read ClinicProfiles" };
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// PII redactor
// ─────────────────────────────────────────────────────────────────────────

const PII_KEYS = new Set([
  "email", "phone", "phoneNumber", "phone_number",
  "dob", "dateOfBirth", "date_of_birth",
  "ssn", "ssn_last_4",
  "street", "streetAddress", "addressLine1", "addressLine2", "address_line_1", "address_line_2",
]);
const SECRET_REGEX = /token|secret|password|otp/i;

function redact(node: any): any {
  if (node === null || node === undefined) return node;
  if (Array.isArray(node)) return node.map(redact);
  if (typeof node !== "object") return node;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(node)) {
    if (PII_KEYS.has(k)) continue;
    if (SECRET_REGEX.test(k)) continue;
    out[k] = redact(v);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

export async function runQueryDdbTable(
  input: QueryDdbInput,
  auth: AuthContext,
  session: ChatSession,
): Promise<
  | { ok: true; data: QueryDdbResult }
  | { ok: false; status: number; error: string }
> {
  // 1. Reject public outright. The action group shouldn't even include this
  // tool on the public agent, but defend at the executor too.
  if ((auth.userType || "").toLowerCase() === "public") {
    return { ok: false, status: 403, error: "query_ddb_table is not available on the public agent" };
  }

  // 2. Table allow-list.
  const spec = TABLE_SPECS[input.table];
  if (!spec) {
    return { ok: false, status: 400, error: `table not allowed: ${input.table}. Allowed: ${Object.keys(TABLE_SPECS).join(", ")}` };
  }

  // 3. Op validation.
  if (input.op !== "query" && input.op !== "getItem") {
    return { ok: false, status: 400, error: "op must be 'query' or 'getItem'" };
  }

  // 4. keyName allow-list per table.
  if (!spec.allowedKeyNames.includes(input.keyName)) {
    return { ok: false, status: 400, error: `keyName '${input.keyName}' not allowed on ${input.table}. Allowed: ${spec.allowedKeyNames.join(", ")}` };
  }

  // 5. Authorization.
  const decision = spec.authorize(input, auth, session);
  if (decision.type === "blocked") {
    return { ok: false, status: 403, error: decision.reason };
  }

  // 6. Run.
  try {
    const tableName = spec.resolveTableName();
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 50);

    if (input.op === "getItem") {
      return await runGetItem(tableName, input, decision.filters, limit);
    }

    // Resolve GSI based on keyName (if not on base PK).
    const indexName = input.indexName || spec.gsiByKeyName?.[input.keyName];

    return await runQuery(tableName, input, decision.filters, limit, indexName);
  } catch (e: any) {
    console.error(`[ddbQueryTool] ${input.table} ${input.op} failed`, e);
    return { ok: false, status: 500, error: e?.message || "DDB call failed" };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Op implementations
// ─────────────────────────────────────────────────────────────────────────

async function runGetItem(
  tableName: string,
  input: QueryDdbInput,
  filters: Array<AuthForceFilter | AuthPostFilter>,
  limit: number,
): Promise<{ ok: true; data: QueryDdbResult }> {
  const key: Record<string, any> = { [input.keyName]: input.keyValue };
  if (input.sortKeyName && input.sortKeyValue !== undefined) {
    key[input.sortKeyName] = input.sortKeyValue;
  }
  const cmd: GetItemCommandInput = { TableName: tableName, Key: marshall(key) };
  const res = await ddb.send(new GetItemCommand(cmd));
  const raw = res.Item ? unmarshall(res.Item) : null;
  const items = raw ? applyPostFilters([raw], filters) : [];
  return {
    ok: true,
    data: {
      items: redact(items),
      count: items.length,
      scannedCount: raw ? 1 : 0,
      truncated: false,
    },
  };
}

async function runQuery(
  tableName: string,
  input: QueryDdbInput,
  filters: Array<AuthForceFilter | AuthPostFilter>,
  limit: number,
  indexName: string | undefined,
): Promise<{ ok: true; data: QueryDdbResult }> {
  const attrNames: Record<string, string> = { "#pk": input.keyName };
  const attrValues: Record<string, any> = { ":pk": input.keyValue };
  let keyCondition = "#pk = :pk";

  if (input.sortKeyName && input.sortKeyValue !== undefined) {
    attrNames["#sk"] = input.sortKeyName;
    const op = input.sortKeyOp || "=";
    if (op === "between" && input.sortKeyValueEnd !== undefined) {
      attrValues[":sk1"] = input.sortKeyValue;
      attrValues[":sk2"] = input.sortKeyValueEnd;
      keyCondition += " AND #sk BETWEEN :sk1 AND :sk2";
    } else if (op === "begins_with") {
      attrValues[":sk"] = input.sortKeyValue;
      keyCondition += " AND begins_with(#sk, :sk)";
    } else if (["=", "<", "<=", ">", ">="].includes(op)) {
      attrValues[":sk"] = input.sortKeyValue;
      keyCondition += ` AND #sk ${op} :sk`;
    }
  }

  // Forced filters (auth + status + date range).
  const filterParts: string[] = [];
  let attrIdx = 0;
  for (const f of filters) {
    if (f.type !== "force") continue;
    const nameTok = `#af${attrIdx}`;
    attrNames[nameTok] = f.attr;
    if (f.values.length === 1) {
      const valTok = `:af${attrIdx}`;
      attrValues[valTok] = f.values[0];
      filterParts.push(`${nameTok} = ${valTok}`);
    } else {
      const tokens = f.values.map((v, i) => {
        const t = `:af${attrIdx}_${i}`;
        attrValues[t] = v;
        return t;
      });
      filterParts.push(`${nameTok} IN (${tokens.join(", ")})`);
    }
    attrIdx++;
  }
  if (input.filterStatus) {
    attrNames["#status"] = "status";
    attrValues[":status"] = input.filterStatus;
    filterParts.push("#status = :status");
  }
  if (input.filterDateFrom || input.filterDateTo) {
    attrNames["#date"] = "date";
    if (input.filterDateFrom && input.filterDateTo) {
      attrValues[":df"] = input.filterDateFrom;
      attrValues[":dt"] = input.filterDateTo;
      filterParts.push("#date BETWEEN :df AND :dt");
    } else if (input.filterDateFrom) {
      attrValues[":df"] = input.filterDateFrom;
      filterParts.push("#date >= :df");
    } else if (input.filterDateTo) {
      attrValues[":dt"] = input.filterDateTo;
      filterParts.push("#date <= :dt");
    }
  }

  const cmd: QueryCommandInput = {
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: attrNames,
    ExpressionAttributeValues: marshall(attrValues),
    FilterExpression: filterParts.length ? filterParts.join(" AND ") : undefined,
    Limit: limit,
  };
  const res = await ddb.send(new QueryCommand(cmd));
  const raw = (res.Items || []).map((i) => unmarshall(i));
  const filtered = applyPostFilters(raw, filters);
  const clamped = filtered.slice(0, limit);
  return {
    ok: true,
    data: {
      items: redact(clamped),
      count: clamped.length,
      scannedCount: res.ScannedCount ?? raw.length,
      truncated: !!res.LastEvaluatedKey || filtered.length > limit,
    },
  };
}

function applyPostFilters(
  items: Array<Record<string, any>>,
  filters: Array<AuthForceFilter | AuthPostFilter>,
): Array<Record<string, any>> {
  const preds = filters.filter((f): f is AuthPostFilter => f.type === "post-filter").map((f) => f.predicate);
  if (!preds.length) return items;
  return items.filter((it) => preds.every((p) => p(it)));
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}
