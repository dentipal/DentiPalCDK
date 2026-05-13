import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandOutput,
    ScanCommand,
    ScanCommandInput,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent } from "aws-lambda";

// --- 1. AWS Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamoClient: DynamoDBClient = new DynamoDBClient({ region: REGION });
const CLINICS_TABLE: string = process.env.CLINICS_TABLE!;

// --- 2. Type Definitions ---

/** Interface for the address parts used in buildAddress function. */
interface AddressParts {
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    state: string;
    pincode: string;
}

/** Interface for the normalized Cognito claims returned by verifyToken. */
export interface UserInfo {
    sub: string;
    userType: string;
    email?: string;
    groups: string[];
    iat?: number;       // JWT issued-at (Unix epoch seconds) — used by the
                        // session-invalidation denylist (see checkSessionNotInvalidated)
    [key: string]: any;
}

/**
 * Clinic-side Cognito group names, normalized to lowercase.
 * Cognito group names come in mixed case (e.g. "ClinicAdmin", "Root") depending on where they're set;
 * always compare case-insensitively using the helpers below.
 */
export const CLINIC_ROLES = ["root", "clinicadmin", "clinicmanager", "clinicviewer"] as const;
export type ClinicRole = typeof CLINIC_ROLES[number];

/**
 * Internal-team Cognito group names (the /admin portal). Stored in canonical
 * Pascal-case as Cognito has them; comparisons against JWT groups use a
 * case-insensitive set below.
 */
export const INTERNAL_GROUPS = ["Admin", "Sales", "Marketing", "HR"] as const;
export type InternalRole = typeof INTERNAL_GROUPS[number];
const INTERNAL_GROUPS_LOWER = new Set(INTERNAL_GROUPS.map(g => g.toLowerCase()));

/** Mutating actions that need a role gate. Read actions don't go through canWriteClinic. */
export type ClinicWriteAction =
    | "manageJobs"       // create / edit / delete job postings, shifts
    | "manageApplicants" // accept / reject / negotiate applications
    | "manageClinic"     // edit clinic profile, settings
    | "manageUsers";     // add / remove / update clinic users

// --- 3. Exported Utility Functions ---

/**
 * Builds a single-line address string from its constituent parts.
 * @param parts - Object containing address parts.
 * @returns A comma-separated, single-line address string.
 */
export const buildAddress = (parts: AddressParts): string => {
    const addressParts: (string | undefined)[] = [parts.addressLine1];
    
    if (parts.addressLine2) addressParts.push(parts.addressLine2);
    if (parts.addressLine3) addressParts.push(parts.addressLine3);
    
    addressParts.push(parts.city, `${parts.state} ${parts.pincode}`);
    
    return addressParts.filter(p => p && p.trim().length > 0).join(", ");
};

/**
 * Case-insensitive check for the Root Cognito group.
 * Cognito group names can arrive as "Root" or "root" depending on how they're set/fetched,
 * so always compare case-insensitively.
 */
export const isRoot = (groups: string[] | undefined | null): boolean =>
    (groups ?? []).some(g => typeof g === "string" && g.toLowerCase() === "root");

/**
 * Case-insensitive: does this group list contain any internal-team group?
 */
export const isInternalUser = (groups: string[] | undefined | null): boolean =>
    (groups ?? []).some(g => typeof g === "string" && INTERNAL_GROUPS_LOWER.has(g.toLowerCase()));

/**
 * Return the canonical-cased internal roles (Admin / Sales / Marketing / HR) the user holds.
 * Compares case-insensitively against the JWT group claim.
 */
export const getInternalRoles = (groups: string[] | undefined | null): InternalRole[] => {
    const present = new Set(
        (groups ?? [])
            .filter((g): g is string => typeof g === "string")
            .map(g => g.toLowerCase())
    );
    return INTERNAL_GROUPS.filter(g => present.has(g.toLowerCase()));
};

/**
 * Gate: does the user hold at least one of the allowed internal roles?
 * Use as the first line in every /admin/* handler.
 */
export const requireInternalGroup = (
    groups: string[] | undefined | null,
    allowed: readonly InternalRole[],
): boolean => {
    const roles = getInternalRoles(groups);
    return roles.some(r => allowed.includes(r));
};

/**
 * Normalize a raw Cognito group list to the single highest-privilege ClinicRole the user holds.
 * Returns null if the user has no clinic-side role.
 */
export const getClinicRole = (groups: string[] | undefined | null): ClinicRole | null => {
    const normalized = new Set(
        (groups ?? [])
            .filter((g): g is string => typeof g === "string")
            .map(g => g.toLowerCase())
    );
    // Priority order: root > admin > manager > viewer.
    for (const role of CLINIC_ROLES) {
        if (normalized.has(role)) return role;
    }
    return null;
};

/**
 * Extract the list of user subs from a DynamoDB `AssociatedUsers` attribute on the Clinics table.
 * The attribute has been stored historically as StringSet (SS), List of {S} (L), or a single String (S);
 * we accept any of those shapes.
 */
const extractAssociatedUsers = (attr: AttributeValue | undefined): string[] => {
    if (!attr) return [];
    if ((attr as any).SS && Array.isArray((attr as any).SS)) return (attr as any).SS as string[];
    if ((attr as any).L && Array.isArray((attr as any).L)) {
        return ((attr as any).L as any[])
            .map(v => (v && typeof v.S === "string" ? v.S : null))
            .filter((v): v is string => !!v);
    }
    if (typeof (attr as any).S === "string") return [(attr as any).S];
    return [];
};

/**
 * READ gate: may this user read data for the given clinicId?
 * The user's sub must appear in Clinics.AssociatedUsers OR equal Clinics.createdBy.
 * One GetItem on the Clinics table; no UserClinicAssignments lookup.
 * Note: Root is a clinic-side role, not a platform superuser — it does NOT bypass
 * this membership check.
 */
export const canAccessClinic = async (
    userSub: string,
    groups: string[] | undefined | null,
    clinicId: string
): Promise<boolean> => {
    if (!userSub || !clinicId) return false;
    if (!CLINICS_TABLE) {
        console.error("[canAccessClinic] CLINICS_TABLE env var is not set");
        return false;
    }

    try {
        const response: GetItemCommandOutput = await dynamoClient.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            ProjectionExpression: "AssociatedUsers, createdBy",
        }));
        if (!response.Item) return false;

        const createdBy = response.Item.createdBy?.S;
        if (createdBy && createdBy === userSub) return true;

        const associated = extractAssociatedUsers(response.Item.AssociatedUsers);
        return associated.includes(userSub);
    } catch (error) {
        console.error(`[canAccessClinic] Error checking access for sub=${userSub} clinicId=${clinicId}:`, error);
        return false;
    }
};

/**
 * WRITE gate: may this user perform `action` on the given clinic?
 * Same membership check as canAccessClinic, plus a role → capability matrix:
 *   root / clinicadmin / clinicmanager → every write action
 *   clinicviewer → no write actions
 * Root no longer bypasses the membership check: a Root user may only write to
 * clinics they own (createdBy) or are associated with (AssociatedUsers).
 */
export const canWriteClinic = async (
    userSub: string,
    groups: string[] | undefined | null,
    clinicId: string,
    _action: ClinicWriteAction
): Promise<boolean> => {
    const role = getClinicRole(groups);
    if (!role || role === "clinicviewer") return false;
    return canAccessClinic(userSub, groups, clinicId);
};

/**
 * List every clinicId the user is allowed to read.
 * Scans Clinics with `contains(AssociatedUsers, :sub) OR createdBy = :sub`,
 * the same membership definition used by loginUser.ts and canAccessClinic.
 * Every user — including Root — is scoped by membership; there is no platform-wide
 * "see everything" tier.
 * The legacy `rootGetsAll` option and the `null` ("all clinics") return value are
 * retained for signature compatibility but no longer produce a broad scan.
 */
export const listAccessibleClinicIds = async (
    userSub: string,
    groups: string[] | undefined | null,
    _opts: { rootGetsAll?: boolean } = {}
): Promise<string[] | null> => {
    if (!userSub) return [];
    if (!CLINICS_TABLE) {
        console.error("[listAccessibleClinicIds] CLINICS_TABLE env var is not set");
        return [];
    }

    const clinicIds: string[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
    try {
        do {
            const input: ScanCommandInput = {
                TableName: CLINICS_TABLE,
                FilterExpression: "contains(AssociatedUsers, :sub) OR createdBy = :sub",
                ExpressionAttributeValues: { ":sub": { S: userSub } },
                ProjectionExpression: "clinicId",
                ExclusiveStartKey,
            };
            const resp = await dynamoClient.send(new ScanCommand(input));
            for (const item of resp.Items || []) {
                const id = item.clinicId?.S;
                if (id) clinicIds.push(id);
            }
            ExclusiveStartKey = resp.LastEvaluatedKey;
        } while (ExclusiveStartKey);
    } catch (error) {
        console.error(`[listAccessibleClinicIds] Error scanning clinics for sub=${userSub}:`, error);
        return [];
    }
    return clinicIds;
};

export const validateToken = (event: APIGatewayProxyEvent): string => {
    // Cast to any to handle both REST Authorizer structure and HTTP API JWT structure
    const authorizer = (event.requestContext as any).authorizer;
    const userSub: string | undefined = authorizer?.claims?.sub || authorizer?.jwt?.claims?.sub;

    if (!userSub) {
        throw new Error("User not authenticated or token invalid");
    }

    return userSub;
};

/**
 * Extract userType from the Cognito `address` attribute.
 *
 * Why this exists: signup writes user type into `address` as a packed string
 * (e.g. "userType:clinic|role:none|clinic:Dr.Smith") instead of a dedicated
 * `custom:user_type` attribute. Callers should still prefer `custom:user_type`
 * when present and fall back to this parser otherwise.
 */
const parseUserTypeFromAddress = (address: unknown): string => {
    if (typeof address !== 'string' || !address) return '';
    const match = address.match(/userType:([^|]+)/);
    return match ? match[1].trim().toLowerCase() : '';
};

/**
 * Derive userType from Cognito groups as a final fallback.
 *
 * Why this exists: some users (e.g. admin-created via createUser.ts) have
 * neither `custom:user_type` nor a parseable `address` field, but they
 * always get assigned to clinic-side Cognito groups (Root / ClinicAdmin /
 * ClinicManager / ClinicViewer). Groups are the universal source of truth
 * for clinic-vs-professional in this system, so we use them as the final
 * derivation step before defaulting.
 */
const deriveUserTypeFromGroups = (groups: string[]): string => {
    if (!groups || groups.length === 0) return '';
    const lowered = groups.map(g => g.toLowerCase());
    // Internal first — an internal user must never fall through to "professional".
    if (lowered.some(g => INTERNAL_GROUPS_LOWER.has(g))) return 'internal';
    return lowered.some(g => (CLINIC_ROLES as readonly string[]).includes(g))
        ? 'clinic'
        : 'professional';
};

export const verifyToken = async (event: APIGatewayProxyEvent): Promise<UserInfo | null> => {
    // Cast to any to handle both REST Authorizer structure and HTTP API JWT structure
    const authorizer = (event.requestContext as any).authorizer;
    const claims: Record<string, any> | undefined = authorizer?.claims || authorizer?.jwt?.claims;
    
    if (!claims || !claims.sub) {
        return null;
    }

    const groupsClaim = claims['cognito:groups'];
    const groups: string[] = typeof groupsClaim === 'string'
        ? groupsClaim.split(',').map((g: string) => g.trim()).filter((g: string) => g.length > 0)
        : Array.isArray(groupsClaim)
        ? groupsClaim
        : [];
        
    const userType: string = claims['custom:user_type']
        || parseUserTypeFromAddress(claims.address)
        || deriveUserTypeFromGroups(groups);

    if (!userType) {
        throw new Error(
            `userType could not be derived for sub=${claims.sub}: ` +
            `custom:user_type missing, address has no userType marker, and no clinic-role groups present. ` +
            `Run the Cognito user_type backfill.`
        );
    }

    return {
        sub: claims.sub,
        userType,
        email: claims.email,
        groups: groups,
    };
};

/**
 * Extracts and decodes the JWT payload from Bearer token in Authorization header.
 * @param authHeader - Authorization header value (e.g., "Bearer eyJhbGc...")
 * @returns Decoded JWT claims object
 * @throws Error if header is missing, invalid format, or token cannot be decoded
 */
export const extractAndDecodeAccessToken = (authHeader: string | undefined): Record<string, any> => {
    console.log('>>> extractAndDecodeAccessToken - ENTRY');
    console.log('>>> authHeader present:', !!authHeader);
    console.log('>>> authHeader type:', typeof authHeader);
    
    if (!authHeader) {
        console.log('>>> extractAndDecodeAccessToken - ERROR: Authorization header missing');
        throw new Error("Authorization header missing");
    }

    const parts = authHeader.split(" ");
    console.log('>>> authHeader parts length:', parts.length);
    console.log('>>> authHeader first part:', parts[0]);
    
    if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") {
        console.log('>>> extractAndDecodeAccessToken - ERROR: Invalid header format');
        throw new Error("Invalid authorization header format. Expected 'Bearer <token>'");
    }

    const token = parts[1];
    const tokenParts = token.split(".");
    console.log('>>> token parts length:', tokenParts.length);
    
    if (tokenParts.length !== 3) {
        console.log('>>> extractAndDecodeAccessToken - ERROR: Invalid token format');
        throw new Error("Invalid access token format");
    }

    try {
        console.log('>>> Attempting to decode token payload...');
        // Decode the payload (second part of JWT)
        const payload = tokenParts[1];
        // Robust Base64URL decode that works across Node versions
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
        const decoded = Buffer.from(base64 + pad, 'base64').toString('utf-8');
        const claims = JSON.parse(decoded);
        
        console.log('>>> extractAndDecodeAccessToken - SUCCESS ✓');
        console.log('>>> Decoded Claims:', JSON.stringify(claims, null, 2));
        console.log('>>> cognito:groups value:', claims['cognito:groups']);
        console.log('>>> cognito:groups type:', typeof claims['cognito:groups']);
        console.log('>>> cognito:groups isArray:', Array.isArray(claims['cognito:groups']));
        console.log('>>> sub value:', claims.sub);
        console.log('>>> extractAndDecodeAccessToken - EXIT');
        
        return claims;
    } catch (error) {
        console.log('>>> extractAndDecodeAccessToken - ERROR: Failed to decode ✗');
        console.error('>>> Decode error:', error);
        throw new Error("Failed to decode access token");
    }
};

/**
 * Extracts user information and groups from JWT claims.
 * Normalizes cognito:groups from comma-separated string or array to array format.
 * @param claims - Decoded JWT claims object
 * @returns Normalized UserInfo object with sub and groups
 * @throws Error if sub is missing
 */
export const extractUserInfoFromClaims = (claims: Record<string, any>): UserInfo => {
    console.log('>>> extractUserInfoFromClaims - ENTRY');
    
    if (!claims.sub) {
        console.log('>>> extractUserInfoFromClaims - ERROR: No sub found');
        throw new Error("User sub not found in token claims");
    }
    console.log('>>> extractUserInfoFromClaims - sub found:', claims.sub);

    console.log('>>> extractUserInfoFromClaims - Full claims object:', JSON.stringify(claims, null, 2));
    
    const groupsClaim = claims['cognito:groups'];
    console.log('>>> extractUserInfoFromClaims - groupsClaim raw value:', groupsClaim);
    console.log('>>> extractUserInfoFromClaims - groupsClaim type:', typeof groupsClaim);
    console.log('>>> extractUserInfoFromClaims - groupsClaim is array:', Array.isArray(groupsClaim));
    
    let groups: string[];
    if (typeof groupsClaim === 'string') {
        console.log('>>> extractUserInfoFromClaims - Processing STRING groups:', groupsClaim);
        groups = groupsClaim.split(',').map((g: string) => g.trim()).filter((g: string) => g.length > 0);
        console.log('>>> extractUserInfoFromClaims - After string split:', groups);
    } else if (Array.isArray(groupsClaim)) {
        console.log('>>> extractUserInfoFromClaims - Processing ARRAY groups:', groupsClaim);
        groups = groupsClaim;
    } else {
        console.log('>>> extractUserInfoFromClaims - No groups found, defaulting to empty array');
        groups = [];
    }
    
    console.log('>>> extractUserInfoFromClaims - Final groups array:', JSON.stringify(groups));
    console.log('>>> extractUserInfoFromClaims - Final groups count:', groups.length);
    
    // Brand-new signups have an access token that lacks `cognito:groups`,
    // `custom:user_type`, and sometimes `address` (Cognito hasn't yet
    // propagated group membership to the access token). Throwing here
    // breaks every authenticated request for new users until they're
    // added to a group. Instead, leave userType empty when it can't be
    // derived — handlers that actually need it can decide what to do
    // (most professional-side endpoints work fine without it because they
    // filter by `userSub` directly).
    const userType: string = claims['custom:user_type']
        || parseUserTypeFromAddress(claims.address)
        || deriveUserTypeFromGroups(groups)
        || '';

    if (!userType) {
        console.log(
            `>>> extractUserInfoFromClaims - userType empty for sub=${claims.sub}; ` +
            `passing through with empty userType (likely brand-new signup).`
        );
    }

    const userInfo: UserInfo = {
        sub: claims.sub,
        userType,
        email: claims.email,
        groups,
        iat: typeof claims.iat === "number" ? claims.iat : undefined,
    };
    
    console.log('>>> extractUserInfoFromClaims - Returning UserInfo:', JSON.stringify(userInfo, null, 2));
    console.log('>>> extractUserInfoFromClaims - EXIT');
    
    return userInfo;
};

/**
 * Auth context used by the refactored `run*` handler functions and the chatbot
 * toolExecutor. Strict superset of UserInfo with optional Cognito attributes
 * the chatbot Lambda can pre-fetch once per session.
 */
export interface AuthContext {
    userSub: string;
    userGroups: string[];
    userType: string;
    email?: string;
    firstName?: string;
    lastName?: string;
}

/**
 * Pulls the Bearer token out of an APIGatewayProxyEvent's headers and returns
 * the normalized AuthContext. Throws the same errors as extractUserFromBearerToken.
 *
 * Used by both:
 *   - thin handler adapters (handler -> extractAuthFromEvent -> run*(input, auth))
 *   - the chatbot toolExecutor, which forwards the original Bearer token via
 *     a synthetic event-like shape ({ headers: { Authorization: ... } })
 */
export const extractAuthFromEvent = (event: any): AuthContext => {
    // In-process trusted bypass: the chatbot toolExecutor invokes existing
    // handlers as black boxes by constructing a synthetic event. It attaches
    // the already-validated AuthContext under `_inProcessAuth` so the handler
    // doesn't need to re-parse a JWT it never received. Only set inside the
    // same Lambda runtime — never from a real API Gateway request.
    if (event && typeof event === "object" && event._inProcessAuth) {
        return event._inProcessAuth as AuthContext;
    }
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    return {
        userSub: userInfo.sub,
        userGroups: userInfo.groups || [],
        userType: userInfo.userType,
        email: userInfo.email,
    };
};

/**
 * One-line wrapper: Extracts and decodes Bearer token, then returns normalized UserInfo.
 * @param authHeader - Authorization header value
 * @returns UserInfo with sub and groups
 * @throws Error with descriptive message if extraction/decoding fails
 */
export const extractUserFromBearerToken = (authHeader: string | undefined): UserInfo => {
    console.log('>>> extractUserFromBearerToken - ENTRY');
    console.log('>>> authHeader provided:', !!authHeader);
    
    try {
        const claims = extractAndDecodeAccessToken(authHeader);
        console.log('>>> extractUserFromBearerToken - Claims decoded successfully');
        
        const userInfo = extractUserInfoFromClaims(claims);
        console.log('>>> extractUserFromBearerToken - UserInfo extracted successfully');
        console.log('>>> extractUserFromBearerToken - EXIT with sub:', userInfo.sub, 'groups:', userInfo.groups);

        return userInfo;
    } catch (error: any) {
        console.log('>>> extractUserFromBearerToken - ERROR ✗');
        console.error('>>> Error:', error.message);
        console.error('>>> Stack:', error.stack);
        throw error;
    }
};

// ============================================================================
// Session invalidation denylist
// ----------------------------------------------------------------------------
// When a user changes their password (or we otherwise need to force-logout
// all their sessions), we write { userSub, invalidatedBefore } to the
// SessionInvalidations table. Handlers that want instant-kick behavior call
// `checkSessionNotInvalidated(userInfo)` after extracting the token; if the
// token's `iat` is older than `invalidatedBefore`, this throws and the
// caller returns 401 (which the frontend turns into a forced logout).
//
// Cost: one DynamoDB GetItem per authenticated request. Latency ~3-5ms.
// ============================================================================

export class SessionInvalidatedError extends Error {
    constructor(message: string = "Session invalidated. Please sign in again.") {
        super(message);
        this.name = "SessionInvalidatedError";
    }
}

/**
 * Throws SessionInvalidatedError if the user's token was issued before the
 * latest password change (or other forced-logout event) was recorded.
 *
 * Returns silently if:
 *   - there's no invalidation record for the user (normal case)
 *   - the token's iat is >= invalidatedBefore (token issued after the change)
 *   - the user's iat couldn't be read (fail-open — never block a legitimate user
 *     just because we can't read the timestamp)
 */
export const checkSessionNotInvalidated = async (userInfo: UserInfo): Promise<void> => {
    const tableName = process.env.SESSION_INVALIDATIONS_TABLE;
    if (!tableName) return;     // table not wired — skip (dev/test safety)
    if (!userInfo?.sub) return;
    if (typeof userInfo.iat !== "number") return;

    try {
        const res: GetItemCommandOutput = await dynamoClient.send(new GetItemCommand({
            TableName: tableName,
            Key: { userSub: { S: userInfo.sub } },
            ProjectionExpression: "invalidatedBefore",
        }));
        const invalidatedBefore = res.Item?.invalidatedBefore?.N
            ? parseInt(res.Item.invalidatedBefore.N, 10)
            : undefined;

        if (typeof invalidatedBefore !== "number") return;
        if (userInfo.iat < invalidatedBefore) {
            throw new SessionInvalidatedError();
        }
    } catch (err: any) {
        if (err instanceof SessionInvalidatedError) throw err;
        // Any other error reading the denylist — fail open (don't block).
        // We'd rather let a request through than lock a user out due to
        // a transient DynamoDB blip.
        console.warn("[checkSessionNotInvalidated] denylist check failed (fail-open)", err?.message);
    }
};