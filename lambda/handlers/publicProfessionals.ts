import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  ScanCommandOutput,
  QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

interface ProfessionalProfileItem {
  userSub?: { S?: string };
  dental_software_experience?: { SS?: string[] };
  first_name?: { S?: string };
  full_name?: { S?: string };
  last_name?: { S?: string };
  role?: { S?: string };
  specialties?: { SS?: string[] };
  years_of_experience?: { N?: string };
}

interface AddressItem {
  city?: { S?: string };
  state?: { S?: string };
  pincode?: { S?: string };
}

interface Profile {
  userSub: string;
  dentalSoftwareExperience: string[];
  firstName: string;
  lastName: string;
  role: string;
  specialties: string[];
  yearsOfExperience: number;
  city: string;
  state: string;
  zipcode: string;
}

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const scanCommand = new ScanCommand({
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
    });

    const result: ScanCommandOutput = await dynamodb.send(scanCommand);

    const profiles: Profile[] = await Promise.all(
      (result.Items || []).map(async (item) => {
        const professionalItem = item as unknown as ProfessionalProfileItem;
        const userSub = professionalItem.userSub?.S || "";

        let city = "";
        let state = "";
        let zipcode = "";

        // Fetch address for this user
        if (userSub) {
          try {
            const queryCommand = new QueryCommand({
              TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
              KeyConditionExpression: "userSub = :userSub",
              ExpressionAttributeValues: {
                ":userSub": { S: userSub },
              },
            });

            const addressResult: QueryCommandOutput = await dynamodb.send(queryCommand);
            const addressItem = (addressResult.Items?.[0] || {}) as unknown as AddressItem;

            city = addressItem.city?.S || "";
            state = addressItem.state?.S || "";
            zipcode = addressItem.pincode?.S || "";
          } catch (addrError) {
            console.warn(`Failed to fetch address for userSub: ${userSub}`, addrError);
          }
        }

        return {
          userSub,
          dentalSoftwareExperience: professionalItem.dental_software_experience?.SS || [],
          firstName: professionalItem.first_name?.S || professionalItem.full_name?.S || "",
          lastName: professionalItem.last_name?.S || "",
          role: professionalItem.role?.S || "",
          specialties: professionalItem.specialties?.SS || [],
          yearsOfExperience: professionalItem.years_of_experience?.N
            ? parseInt(professionalItem.years_of_experience.N)
            : 0,
          city,
          state,
          zipcode,
        };
      })
    );

    return json(200, {
      success: true,
      message: "Professional profiles with address details (city, state, pincode) retrieved successfully",
      profiles,
      count: profiles.length,
    });

  } catch (error: any) {
    console.error("Error fetching professional profiles:", error);

    return json(500, {
      success: false,
      message: "Error fetching professional profiles",
      error: error.message,
    });
  }
};