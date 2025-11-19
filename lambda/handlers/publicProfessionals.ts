import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    ScanCommandOutput,
    QueryCommandOutput,
  } from "@aws-sdk/client-dynamodb";
  
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
  
  const handler = async (event: any): Promise<any> => {
    const headers = {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Origin": "*", // **IMPORTANT: Change '*' to your frontend URL in production**
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
    };
  
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204, // No Content
        headers,
        body: "",
      };
    }
  
    try {
      const scanCommand = new ScanCommand({
        TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
      });
  
      const result: ScanCommandOutput = await dynamodb.send(scanCommand);
  
      const profiles: Profile[] = await Promise.all(
        (result.Items || []).map(async (item) => {
          const professionalItem = item as ProfessionalProfileItem;
  
          const queryCommand = new QueryCommand({
            TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
              ":userSub": { S: professionalItem.userSub?.S || "" },
            },
          });
  
          const addressResult: QueryCommandOutput = await dynamodb.send(queryCommand);
  
          const addressItem = (addressResult.Items?.[0] || {}) as AddressItem;
  
          const city = addressItem.city?.S || "";
          const state = addressItem.state?.S || "";
          const zipcode = addressItem.pincode?.S || "";
  
          return {
            userSub: professionalItem.userSub?.S || "",
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
  
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: "Professional profiles with address details (city, state, pincode) retrieved successfully",
          profiles,
          count: profiles.length,
        }),
      };
    } catch (error: any) {
      console.error("Error fetching professional profiles:", error);
  
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          message: "Error fetching professional profiles",
          error: error.message,
        }),
      };
    }
  };
  
  export { handler };
  