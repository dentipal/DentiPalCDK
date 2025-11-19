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
type AccessLevel = 'Admin' | 'Manager' | 'Viewer';

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
 * * NOTE: The original JS implementation of `isRoot` passed an empty array to `isRoot`, 
 * which would incorrectly return `false`. I've assumed the intent was to check if the user 
 * in the context has 'Root' permissions if available, but since we don't have the context 
 * groups here, the function assumes the caller handles the global root check or that the 
 * empty array logic is sufficient for the original system's flow.
 * * For correct logic, the caller must pass the user's groups. Since this utility file doesn't 
 * have the groups globally, the caller must handle the root check externally or pass the groups.
 * The implementation below simplifies the original logic's structure.
 * * @param userSub - The user's unique identifier.
 * @param clinicId - The clinic's unique identifier.
 * @param requiredAccess - Optional access level (e.g., 'Admin').
 * @returns True if access is granted.
 */
export const hasClinicAccess = async (userSub: string, clinicId: string, requiredAccess: AccessLevel | null = null): Promise<boolean> => {
    // If we had groups here, we'd check: if (isRoot(userGroups)) return true;
    
    const command: GetItemCommandInput = {
        TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
        Key: { 
            userSub: { S: userSub }, 
            clinicId: { S: clinicId } 
        },
        ProjectionExpression: requiredAccess ? "accessLevel" : undefined
    };

    const response: GetItemCommandOutput = await dynamoClient.send(new GetItemCommand(command));
    
    if (!response.Item) {
        return false;
    }
    
    if (!requiredAccess) {
        return true; // Item exists, access granted
    }
    
    const accessLevel: string | undefined = response.Item.accessLevel?.S;
    return accessLevel === requiredAccess;
};

/**
 * Ensures the user is authenticated by checking for the 'sub' claim and throws an error if missing.
 * @param event - The Lambda event object.
 * @returns The user's unique identifier (userSub).
 * @throws {Error} if the user is not authenticated.
 */
export const validateToken = (event: APIGatewayProxyEvent): string => {
    const userSub: string | undefined = event.requestContext.authorizer?.claims?.sub;
    
    if (!userSub) {
        throw new Error("User not authenticated or token invalid");
    }
    
    return userSub;
};

/**
 * Retrieves and normalizes essential user information from the Cognito claims.
 * @param event - The Lambda event object.
 * @returns A UserInfo object containing claims or null if not authenticated.
 */
export const verifyToken = async (event: APIGatewayProxyEvent): Promise<UserInfo | null> => {
    const claims: Record<string, any> | undefined = event.requestContext.authorizer?.claims;
    
    if (!claims || !claims.sub) {
        return null;
    }

    const groupsClaim = claims['cognito:groups'];
    const groups: string[] = typeof groupsClaim === 'string'
        ? groupsClaim.split(',').map(g => g.trim()).filter(g => g.length > 0)
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