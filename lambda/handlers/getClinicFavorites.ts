import {
    DynamoDBClient,
    QueryCommand,
    BatchGetItemCommand,
    QueryCommandOutput,
    BatchGetItemCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Type Definitions ---

// Simplified type for a raw DynamoDB item
interface DynamoDBItem {
    userSub?: AttributeValue;
    professionalUserSub?: AttributeValue;
    addedAt?: AttributeValue;
    updatedAt?: AttributeValue;
    notes?: AttributeValue; // S
    tags?: AttributeValue; // SS
    // Profile Fields
    first_name?: AttributeValue;
    last_name?: AttributeValue;
    role?: AttributeValue;
    profile_image?: AttributeValue;
    years_of_experience?: AttributeValue; // N
    dental_software_experience?: AttributeValue; // SS
    languages_known?: AttributeValue; // SS
    has_dental_office_experience?: AttributeValue; // BOOL
    createdAt?: AttributeValue;
    // Address Fields
    city?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped professional details
interface ProfessionalDetails {
    userSub: string;
    first_name: string;
    last_name: string;
    role: string;
    city: string;
    profile_image: string | null;
    years_of_experience: number | null;
    dental_software_experience: string[];
    languages_known: string[];
    has_dental_office_experience: boolean;
    createdAt?: string;
}

// Interface for the final mapped favorite item
interface FavoriteItem {
    professionalUserSub: string;
    addedAt: string;
    updatedAt: string;
    notes: string | null;
    tags: string[];
    professional: ProfessionalDetails | null;
}

// Interface for the final response body
interface ResponseBody {
    message: string;
    favorites: FavoriteItem[];
    count: number;
    totalFavorites: number;
    roleDistribution: Record<string, number>;
    filters: {
        role: string | null;
        tags: string[] | null;
    };
}

/**
 * AWS Lambda handler to retrieve a clinic's list of favorited professionals, 
 * enriched with profile and address details.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Preflight
    if (event && event.httpMethod === "OPTIONS") {
        // ✅ Uses imported headers
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication
        // validateToken is assumed to return the userSub (string) and throw on failure.
        const userSub: string = await validateToken(event);

        // 2. Get query parameters
        const queryParams = event.queryStringParameters || {};
        const limit: number = queryParams.limit ? parseInt(queryParams.limit, 10) : 50;
        const role: string | undefined = queryParams.role; 
        const tags: string[] | null = queryParams.tags ? queryParams.tags.split(',').map(t => t.trim()).filter(Boolean) : null;

        // 3. Query clinic's favorites
        const queryCommand = new QueryCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            KeyConditionExpression: 'clinicUserSub = :clinicUserSub',
            ExpressionAttributeValues: {
                ':clinicUserSub': { S: userSub }
            },
            Limit: limit,
            ScanIndexForward: false, // Most recent first
        });
        const favoritesResult: QueryCommandOutput = await dynamodb.send(queryCommand);
        const rawFavorites: DynamoDBItem[] = (favoritesResult.Items as DynamoDBItem[] || []);

        if (rawFavorites.length === 0) {
            return {
                statusCode: 200,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    message: "No favorites found",
                    favorites: [],
                    count: 0,
                    totalFavorites: 0,
                    roleDistribution: {},
                    filters: { role: role || null, tags: tags || null }
                } as ResponseBody),
            };
        }

        // 4. Prepare BatchGet keys
        const professionalUserSubs: { userSub: string }[] = rawFavorites.map(item => ({
            userSub: item.professionalUserSub!.S! // Assumed to be non-null after validation
        }));

        const keysToGet = professionalUserSubs.map(prof => ({
            userSub: { S: prof.userSub }
        }));
        
        // 5. Batch Get Professional Profiles and Addresses concurrently
        
        // Profiles BatchGet
        const profileRequestItems: Record<string, any> = {};
        profileRequestItems[process.env.PROFESSIONAL_PROFILES_TABLE!] = { Keys: keysToGet };
        const profilesResult: BatchGetItemCommandOutput = await dynamodb.send(new BatchGetItemCommand({
            RequestItems: profileRequestItems
        }));
        const profiles: DynamoDBItem[] = profilesResult.Responses?.[process.env.PROFESSIONAL_PROFILES_TABLE!] as DynamoDBItem[] || [];

        // Addresses BatchGet
        const addressRequestItems: Record<string, any> = {};
        addressRequestItems[process.env.USER_ADDRESSES_TABLE!] = { Keys: keysToGet };
        const addressesResult: BatchGetItemCommandOutput = await dynamodb.send(new BatchGetItemCommand({
            RequestItems: addressRequestItems
        }));
        const addresses: DynamoDBItem[] = addressesResult.Responses?.[process.env.USER_ADDRESSES_TABLE!] as DynamoDBItem[] || [];

        // 6. Combine favorites with professional details and addresses
        const favoritesWithDetails: FavoriteItem[] = rawFavorites.map(favorite => {
            const profSub = favorite.professionalUserSub!.S!;
            
            // Find related items
            const professionalProfile = profiles.find(profile => profile.userSub!.S === profSub);
            const address = addresses.find(addr => addr.userSub!.S === profSub);
            
            let professionalDetails: ProfessionalDetails | null = null;
            if (professionalProfile) {
                professionalDetails = {
                    userSub: professionalProfile.userSub!.S!,
                    first_name: professionalProfile.first_name?.S || 'Unknown',
                    last_name: professionalProfile.last_name?.S || 'Unknown',
                    role: professionalProfile.role?.S || 'Unknown',
                    city: address?.city?.S || 'N/A', // Add city from USER_ADDRESSES_TABLE
                    profile_image: professionalProfile.profile_image?.S || null,
                    years_of_experience: professionalProfile.years_of_experience?.N ?
                        parseInt(professionalProfile.years_of_experience.N, 10) : null,
                    dental_software_experience: professionalProfile.dental_software_experience?.SS || [],
                    languages_known: professionalProfile.languages_known?.SS || [],
                    has_dental_office_experience: professionalProfile.has_dental_office_experience?.BOOL || false,
                    createdAt: professionalProfile.createdAt?.S
                };
            }
            
            // Map the favorite item itself
            const favoriteData: FavoriteItem = {
                professionalUserSub: profSub,
                addedAt: favorite.addedAt!.S!,
                updatedAt: favorite.updatedAt!.S!,
                notes: favorite.notes?.S || null,
                tags: favorite.tags?.SS || [],
                professional: professionalDetails
            };
            return favoriteData;
        });

        // 7. Apply query filters
        let filteredFavorites = favoritesWithDetails.filter(fav => fav.professional !== null) as FavoriteItem[];

        // Filter by professional role
        if (role) {
            filteredFavorites = filteredFavorites.filter(fav => fav.professional?.role === role);
        }

        // Filter by tags (must contain *at least one* of the specified tags)
        if (tags && tags.length > 0) {
            filteredFavorites = filteredFavorites.filter(fav => tags.some((tag) => fav.tags.includes(tag)));
        }

        // 8. Group by role for summary
        const roleStats: Record<string, number> = filteredFavorites.reduce((acc, fav) => {
            const roleKey = fav.professional?.role || 'Unknown';
            acc[roleKey] = (acc[roleKey] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        // 9. Final Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                message: "Favorites retrieved successfully",
                favorites: filteredFavorites,
                count: filteredFavorites.length,
                totalFavorites: rawFavorites.length,
                roleDistribution: roleStats,
                filters: {
                    role: role || null,
                    tags: tags || null
                }
            } as ResponseBody),
        };
    }
    catch (error: any) {
        console.error("Error getting clinic favorites:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({ error: error.message })
        };
    }
};