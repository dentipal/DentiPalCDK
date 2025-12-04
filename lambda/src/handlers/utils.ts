import { 
    DynamoDBClient, 
    GetItemCommand, 
    GetItemCommandInput, 
    GetItemCommandOutput,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent } from "aws-lambda";

// --- 1. AWS Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamoClient: DynamoDBClient = new DynamoDBClient({ region: REGION });
const USER_CLINIC_ASSIGNMENTS_TABLE: string = process.env.USER_CLINIC_ASSIGNMENTS_TABLE!;

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

/** Access level constants */
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
 * Checks if a user belongs to the 'Root' group.
 * @param groups - Array of Cognito group names.
 * @returns True if the user is a Root user.
 */
export const isRoot = (groups: string[]): boolean => groups.includes('Root');

/**
 * Checks if a user has access to a specific clinic and optionally verifies the required access level.
 * Access is granted if the user is 'Root' or if an entry exists in the USER_CLINIC_ASSIGNMENTS_TABLE.
 * * @param userSub - The user's unique identifier.
 * @param clinicId - The clinic's unique identifier.
 * @param requiredAccess - Optional access level (e.g., 'ClinicAdmin').
 * @returns True if access is granted.
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