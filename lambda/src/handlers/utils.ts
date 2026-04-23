import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandInput,
    GetItemCommandOutput,
    ScanCommand,
    ScanCommandInput,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent } from "aws-lambda";

// --- 1. AWS Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamoClient: DynamoDBClient = new DynamoDBClient({ region: REGION });
const USER_CLINIC_ASSIGNMENTS_TABLE: string = process.env.USER_CLINIC_ASSIGNMENTS_TABLE!;
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
    [key: string]: any;
}

/**
 * Clinic-side Cognito group names, normalized to lowercase.
 * Cognito group names come in mixed case (e.g. "ClinicAdmin", "Root") depending on where they're set;
 * always compare case-insensitively using the helpers below.
 */
export const CLINIC_ROLES = ["root", "clinicadmin", "clinicmanager", "clinicviewer"] as const;
export type ClinicRole = typeof CLINIC_ROLES[number];

/** Mutating actions that need a role gate. Read actions don't go through canWriteClinic. */
export type ClinicWriteAction =
    | "manageJobs"       // create / edit / delete job postings, shifts
    | "manageApplicants" // accept / reject / negotiate applications
    | "manageClinic"     // edit clinic profile, settings
    | "manageUsers";     // add / remove / update clinic users

/**
 * @deprecated Legacy access level used by hasClinicAccess() against UserClinicAssignments.
 * The Add User flow does not populate UserClinicAssignments, so these labels are effectively dead.
 * New code should use ClinicRole + canAccessClinic / canWriteClinic.
 */
export type AccessLevel = "ClinicAdmin" | "Doctor" | "Receptionist";

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
 * Root → always true.
 * Otherwise → the user's sub must appear in Clinics.AssociatedUsers OR equal Clinics.createdBy.
 * One GetItem on the Clinics table; no UserClinicAssignments lookup.
 */
export const canAccessClinic = async (
    userSub: string,
    groups: string[] | undefined | null,
    clinicId: string
): Promise<boolean> => {
    if (!userSub || !clinicId) return false;
    if (isRoot(groups)) return true;
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
 *   root       → every action
 *   clinicadmin / clinicmanager → every write action
 *   clinicviewer → no write actions
 * Helpers land here for follow-up enforcement on mutating endpoints; this PR wires reads only.
 */
export const canWriteClinic = async (
    userSub: string,
    groups: string[] | undefined | null,
    clinicId: string,
    _action: ClinicWriteAction
): Promise<boolean> => {
    if (isRoot(groups)) return true;
    const role = getClinicRole(groups);
    if (!role || role === "clinicviewer") return false;
    return canAccessClinic(userSub, groups, clinicId);
};

/**
 * List every clinicId the user is allowed to read.
 * Root → null, signalling "all clinics" so the caller can take its broad-scan path.
 * Non-root → scans Clinics with `contains(AssociatedUsers, :sub) OR createdBy = :sub`,
 * the same membership definition used by loginUser.ts and canAccessClinic.
 */
export const listAccessibleClinicIds = async (
    userSub: string,
    groups: string[] | undefined | null,
    { rootGetsAll = true }: { rootGetsAll?: boolean } = {}
): Promise<string[] | null> => {
    if (rootGetsAll && isRoot(groups)) return null;
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

/**
 * @deprecated Reads the UserClinicAssignments table, which is not populated by the Add User flow.
 * New code should use `canAccessClinic` (reads) or `canWriteClinic` (writes) instead.
 * Retained as a thin legacy helper so any existing callers keep compiling.
 */
export const hasClinicAccess = async (userSub: string, clinicId: string, requiredAccess: AccessLevel | null = null): Promise<boolean> => {
    const command: GetItemCommandInput = {
        TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
        Key: {
            userSub: { S: userSub },
            clinicId: { S: clinicId }
        },
        ProjectionExpression: requiredAccess ? "accessLevel" : undefined
    };

    try {
        const response: GetItemCommandOutput = await dynamoClient.send(new GetItemCommand(command));

        if (!response.Item) {
            return false;
        }

        if (!requiredAccess) {
            return true; // Item exists, access granted
        }

        const accessLevel: string | undefined = response.Item.accessLevel?.S;
        return accessLevel === requiredAccess;
    } catch (error) {
        console.error("Error checking clinic access:", error);
        return false;
    }
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
        
    return {
        sub: claims.sub,
        userType: claims['custom:user_type'] || 'professional',
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
    
    const userInfo: UserInfo = {
        sub: claims.sub,
        userType: claims['custom:user_type'] || 'professional',
        email: claims.email,
        groups,
    };
    
    console.log('>>> extractUserInfoFromClaims - Returning UserInfo:', JSON.stringify(userInfo, null, 2));
    console.log('>>> extractUserInfoFromClaims - EXIT');
    
    return userInfo;
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