const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
};

const unmarshallClinic = (clinic) => {
  if (!clinic) return null;

  const safeParseInt = (attr) => (attr?.N ? parseInt(attr.N, 10) : 0);

  return {
    clinicId: clinic.clinicId?.S || "",
    userSub: clinic.userSub?.S || "",
    clinicName: clinic.clinic_name?.S || "",
    practiceType: clinic.practice_type?.S || "",
    primaryPracticeArea: clinic.primary_practice_area?.S || "",
    primaryContactFirstName: clinic.primary_contact_first_name?.S || "",
    primaryContactLastName: clinic.primary_contact_last_name?.S || "",
    assistedHygieneAvailable: clinic.assisted_hygiene_available?.BOOL || false,
    numberOfOperatories: safeParseInt(clinic.number_of_operatories),
    numHygienists: safeParseInt(clinic.num_hygienists),
    numAssistants: safeParseInt(clinic.num_assistants),
    numDoctors: safeParseInt(clinic.num_doctors),
    bookingOutPeriod: clinic.booking_out_period?.S || "",
    softwareUsed: clinic.software_used?.S || "",
    parkingType: clinic.parking_type?.S || "",
    freeParkingAvailable: clinic.free_parking_available?.BOOL || false,
    createdAt: clinic.createdAt?.S || "",
    updatedAt: clinic.updatedAt?.S || "",
    location: {
      addressLine1: clinic.addressLine1?.S || "",
      city: clinic.city?.S || "",
      state: clinic.state?.S || "",
      zipCode: clinic.zip_code?.S || "",
    },
    contactInfo: {
      email: clinic.contact_email?.S || "",
      phone: clinic.clinic_phone?.S || "",
    },
    insurancePlansAccepted: clinic.insurance_plans_accepted?.SS || [],
    createdBy: clinic.createdBy?.S || "",
    website: clinic.website?.S || "",
    dentalAssociation: clinic.dental_association?.S || "",
    notes: clinic.notes?.S || "",
  };
};

const handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({}),
      };
    }

    const decodedToken = await validateToken(event);
    if (!decodedToken) {
      console.error("❌ Token validation failed");
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized - Invalid token" }),
      };
    }

    const userSub = decodedToken;

    const path = event.path || "";
    const clinicId = path.split("/").filter(Boolean).pop();

    if (!clinicId) {
      console.error("Clinic ID is missing from the path.");
      return { 
        statusCode: 400, 
        headers: corsHeaders, 
        body: JSON.stringify({ error: "Clinic ID missing in request path." }) 
      };
    }

    const getItemParams = {
      TableName: CLINIC_PROFILES_TABLE,
      Key: {
        clinicId: { S: clinicId },
        userSub: { S: userSub }, // Use userSub from the token here
      },
    };

    const result = await dynamodb.send(new GetItemCommand(getItemParams));

    if (!result.Item) {
      console.error(`❌ No profile found for clinicId ${clinicId} and userSub ${userSub}`);
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: `Clinic profile not found` }),
      };
    }

    const fetchedUserSub = result.Item.userSub?.S;
    if (fetchedUserSub !== userSub) {
      console.error(`Authorization failed: Clinic userSub (${fetchedUserSub}) does not match token userSub (${userSub})`);
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Forbidden: You do not own this clinic profile." }),
      };
    }

    const clinicData = unmarshallClinic(result.Item);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Clinic profile retrieved successfully",
        profile: clinicData,
      }),
    };
  } catch (error) {
    console.error("DETAILED ERROR:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to retrieve clinic profile" }),
    };
  }
};

exports.handler = handler;
