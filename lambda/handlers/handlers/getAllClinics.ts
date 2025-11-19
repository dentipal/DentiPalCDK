// index.ts
import {
    DynamoDBClient,
    ScanCommand,
    ScanCommandInput,
    AttributeValue,
    ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken, isRoot } from "./utils"; 

// Initialize the DynamoDB client (AWS SDK v3)
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// --- Type Definitions ---

// Interface for the transformed clinic object in the response
interface ClinicResponseItem {
    clinicId: string;
    name: string;
    address: string; // Combined address string
    createdAt: string;
    updatedAt: string;
    createdBy: string | null;
    associatedUsers: string[];
    [key: string]: any;
}

// Interface for the transformed attribute values from DynamoDB
interface DynamoDBClinicItem {
    clinicId?: AttributeValue;
    name?: AttributeValue;
    createdBy?: AttributeValue;
    AssociatedUsers?: AttributeValue; // Assumed to be List (L)
    createdAt?: AttributeValue;
    updatedAt?: AttributeValue;
    addressLine1?: AttributeValue;
    addressLine2?: AttributeValue;
    addressLine3?: AttributeValue;
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

// Define CORS headers
const headers = {
    "Access-Control-Allow-Origin": "*", // Allow any origin, modify for stricter security
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow specific methods
    "Access-Control-Allow-Headers": "Content-Type, Authorization" // Allow specific headers
};

/**
 * AWS Lambda handler to retrieve a list of clinics based on user permissions and filters.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Validate token and retrieve user information
        // validateToken is assumed to return the userSub (string) and throw on failure.
        const userSub: string = validateToken(event);
        
        // Get user groups from authorizer claims (assuming groups is a comma-separated string)
        const groupsRaw = (event.requestContext.authorizer?.claims as any)?.['cognito:groups'];
        const groups: string[] = (typeof groupsRaw === 'string' ? groupsRaw.split(',') : [])
            .map(s => s.trim())
            .filter(Boolean);
            
        const queryParams = event.queryStringParameters || {};

        const limit: number = queryParams.limit ? parseInt(queryParams.limit, 10) : 50;
        const state: string | undefined = queryParams.state;
        const city: string | undefined = queryParams.city;
        const name: string | undefined = queryParams.name;

        const filterExpressions: string[] = [];
        const expressionAttributeValues: Record<string, AttributeValue> = {};
        const expressionAttributeNames: Record<string, string> = {};

        // 2. Add Query Filters
        // Use ExpressionAttributeNames for potential reserved keywords (state, city, name)
        if (state) {
            filterExpressions.push("contains(#state_attr, :state)");
            expressionAttributeValues[":state"] = { S: state };
            expressionAttributeNames["#state_attr"] = "state";
        }
        if (city) {
            filterExpressions.push("contains(#city_attr, :city)");
            expressionAttributeValues[":city"] = { S: city };
            expressionAttributeNames["#city_attr"] = "city";
        }
        if (name) {
            filterExpressions.push("contains(#name_attr, :name)");
            expressionAttributeValues[":name"] = { S: name };
            expressionAttributeNames["#name_attr"] = "name";
        }

        // 3. Core Logic for User Type Filtering
        const isRootUser: boolean = isRoot(groups);

        if (isRootUser) {
            // Root user: filter clinics by 'createdBy' attribute (PK of the clinic should be userSub)
            filterExpressions.push("createdBy = :userSub");
            expressionAttributeValues[":userSub"] = { S: userSub };
            console.log(`🔒 Root user (${userSub}): Filtering clinics by 'createdBy'.`);
        } else {
            // Non-root users: filter by 'AssociatedUsers' attribute (must contain userSub)
            // NOTE: This requires 'AssociatedUsers' to be indexed or uses an inefficient Scan/Filter.
            filterExpressions.push("contains(AssociatedUsers, :userSub)");
            expressionAttributeValues[":userSub"] = { S: userSub };
            console.log(`🔒 Non-root user (${userSub}): Filtering clinics by 'AssociatedUsers'.`);
        }
        
        // 4. Create DynamoDB Scan Command Input
        const scanCommand: ScanCommandInput = {
            TableName: process.env.CLINICS_TABLE,
            Limit: limit,
        };

        if (filterExpressions.length > 0) {
            scanCommand.FilterExpression = filterExpressions.join(" AND ");
            scanCommand.ExpressionAttributeValues = expressionAttributeValues;
            
            // Only include ExpressionAttributeNames if necessary (keys exist)
            if (Object.keys(expressionAttributeNames).length > 0) {
                scanCommand.ExpressionAttributeNames = expressionAttributeNames;
            }
        }

        // 5. Fetch clinics from DynamoDB
        const response: ScanCommandOutput = await dynamoClient.send(new ScanCommand(scanCommand));

        if (!response.Items || response.Items.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    status: "success",
                    clinics: [],
                    totalCount: 0,
                    message: "No clinics found"
                })
            };
        }

        console.log("🔍 Raw items from DynamoDB:", JSON.stringify(response.Items, null, 2));

        // 6. Map and Transform Items
        const clinics: ClinicResponseItem[] = (response.Items as DynamoDBClinicItem[]).map(item => {
            // Extract raw values
            const createdBy = item.createdBy?.S || null;
            
            // Handle AssociatedUsers list (L) type
            const associatedUsersRaw: AttributeValue[] = item.AssociatedUsers?.L || [];
            const associatedUsers: string[] = associatedUsersRaw
                .map(user => user.S)
                .filter((s): s is string => !!s); // Filter out any null/undefined subs

            // Combine granular address fields into a single 'address' string
            const addressParts = [
                item.addressLine1?.S,
                item.addressLine2?.S,
                item.addressLine3?.S,
                item.city?.S,
                item.state?.S,
                item.pincode?.S
            ].filter((s): s is string => !!s); // Filter out null/undefined/empty strings
            
            const combinedAddress = addressParts.join(", ");

            const clinic: ClinicResponseItem = {
                clinicId: item.clinicId?.S || '',
                name: item.name?.S || '',
                address: combinedAddress,
                createdAt: item.createdAt?.S || '',
                updatedAt: item.updatedAt?.S || '',
                createdBy,
                associatedUsers
            };
            return clinic;
        });
        
        // 7. Success Response
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                clinics: clinics,
                totalCount: clinics.length,
                filters: {
                    state: state || null,
                    city: city || null,
                    name: name || null,
                    limit
                },
                currentUser: {
                    userSub,
                    isRoot: isRootUser,
                    groups
                },
                message: `Retrieved ${clinics.length} clinic(s)`
            })
        };

    } catch (error: any) {
        console.error("❌ Error retrieving clinics:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Failed to retrieve clinics. Please try again.",
                details: error.message
            })
        };
    }
};