"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

// 1. IMPORT AdminCreateUserCommand and remove SignUpCommand
const {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand
} = require("@aws-sdk/client-cognito-identity-provider");

const { DynamoDB } = require("aws-sdk");
const SES = require("aws-sdk/clients/ses"); // Import SES at the top

const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDB.DocumentClient();
const ses = new SES({ region: process.env.REGION }); // Initialize SES at the top

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // Allow all domains (adjust for security)
  "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const handler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event));

    // Handle preflight CORS request
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({}),
      };
    }

    // 1️⃣ Verify Root User
    const userGroups = event.requestContext?.authorizer?.claims?.['cognito:groups'] || [];
    if (!userGroups.includes("Root")) {
      console.warn("Unauthorized user tried to add new user:", userGroups);
      return {
        statusCode: 403,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized: Only Root users can add new users" }),
      };
    }

    // 2️⃣ Parse the body
    const body = JSON.parse(event.body);
    console.log("Parsed body:", body);

    const { firstName, lastName, phoneNumber, email, password, verifyPassword, subgroup, clinicIds, sendWelcomeEmail } = body;

    // Log each field for debugging
    console.log("First Name:", firstName);
    console.log("Last Name:", lastName);
    console.log("Phone Number:", phoneNumber);
    console.log("Email:", email);
    console.log("Password:", password);
    console.log("Verify Password:", verifyPassword);
    console.log("Subgroup:", subgroup);
    console.log("Clinic IDs:", clinicIds);
    console.log("Send Welcome Email:", sendWelcomeEmail); // <-- Added log for debugging

    // Validate password match
    if (password !== verifyPassword) {
      console.error("Passwords do not match");
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Passwords do not match" }),
      };
    }

    // Validate required fields
    if (!firstName || !lastName || !phoneNumber || !email || !password || !subgroup || !clinicIds || clinicIds.length === 0) {
      console.error("Missing required fields:", { firstName, lastName, phoneNumber, email, password, subgroup, clinicIds });
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    // Validate the subgroup
    const validGroups = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
    if (!validGroups.includes(subgroup)) {
      console.error("Invalid subgroup:", subgroup);
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Invalid subgroup" }),
      };
    }

    // 3️⃣ Create Cognito user (Admin Flow)
    const adminCreateUserCommand = new AdminCreateUserCommand({
      UserPoolId: process.env.USER_POOL_ID, // Use UserPoolId
      Username: email,
      TemporaryPassword: password, // Set as temporary password
      MessageAction: "SUPPRESS", // Stop Cognito from sending its own welcome email
      UserAttributes: [
        { Name: "given_name", Value: firstName },
        { Name: "family_name", Value: lastName },
        { Name: "phone_number", Value: phoneNumber },
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" } // Mark as verified
      ],
    });

    const createUserResponse = await cognitoClient.send(adminCreateUserCommand);
    console.log("Cognito admin create user response:", createUserResponse);

    // Get the new user's 'sub' (unique ID) from the response
    const userSub = createUserResponse.User.Attributes.find(
      (attr) => attr.Name === "sub"
    )?.Value; // Added optional chaining for safety

    if (!userSub) {
      console.error("Could not find UserSub in Cognito response:", createUserResponse);
      throw new Error("Could not find UserSub (sub) in Cognito response.");
    }
    console.log(`New user created with UserSub: ${userSub}`);
    // 3.1️⃣ Set the password as permanent
    console.log(`Setting permanent password for ${email}...`);
    const setPasswordCommand = new AdminSetUserPasswordCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      Password: password, // The same password from the request
      Permanent: true   // This is the important flag
    });

    await cognitoClient.send(setPasswordCommand);
    console.log(`Permanent password set for ${email}.`);
    // Add user to group
    const addToGroupCommand = new AdminAddUserToGroupCommand({
      UserPoolId: process.env.USER_POOL_ID,
      Username: email,
      GroupName: subgroup,
    });
    await cognitoClient.send(addToGroupCommand);
    console.log(`User ${email} added to group ${subgroup}`);

    // 4️⃣ Store userSub in the clinics' associated users
    for (const clinicId of clinicIds) {
      const clinicParams = { TableName: "DentiPal-Clinics", Key: { clinicId } };

      // Fetch the clinic from DynamoDB
      const clinicResponse = await dynamodb.get(clinicParams).promise();
      if (!clinicResponse.Item) {
        console.warn(`Clinic not found for clinicId: ${clinicId}`);
        continue; // Skip missing clinics
      }

      // Update the clinic's associated users list with the new user
      const clinicUpdateParams = {
        TableName: "DentiPal-Clinics",
        Key: { clinicId },
        UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty_list), :userSub)",
        ExpressionAttributeValues: {
          ":userSub": [userSub], // <-- Use the correct userSub variable
          ":empty_list": [],
        },
        ReturnValues: "UPDATED_NEW",
      };

      await dynamodb.update(clinicUpdateParams).promise();
      console.log(`Clinic ${clinicId} updated with new userSub: ${userSub}`);
    }

    // 5️⃣ Send welcome email (optional)
    if (sendWelcomeEmail) {
      console.log(`Attempting to send welcome email to ${email}...`);

      // Build both text and HTML bodies
      const subject = "Your DentiPal account details";
      const textBody =
        `Hello ${firstName},\n\n` +
        `Your DentiPal account has been created.\n\n` +
        `Email: ${email}\n` +
        `Password: ${password}\n` + // The temporary password
        `Role: ${subgroup}\n` +
        (Array.isArray(clinicIds) && clinicIds.length ? `Clinics: ${clinicIds.join(", ")}\n` : "") +
        `\nFor security, please sign in and change your password immediately.\n` +
        `If you did not expect this email, please contact your administrator.\n`;

      const htmlBody =
        `<p>Hello ${firstName},</p>` +
        `<p>Your DentiPal account has been created.</p>` +
        `<ul>` +
        `<li><b>Email:</b> ${email}</li>` +
        `<li><b>Password:</b> ${password}</li>` + // The temporary password
        `<li><b>Role:</b> ${subgroup}</li>` +
        (Array.isArray(clinicIds) && clinicIds.length ? `<li><b>Clinics:</b> ${clinicIds.join(", ")}</li>` : "") +
        `</ul>` +
        `<p><i>For security, please sign in and change your password immediately.</i></p>` +
        `<p>If you did not expect this email, please contact your administrator.</p>`;

      await ses.sendEmail({
        Source: "swarajparamata@gmail.com", // <-- IMPORTANT: This email MUST be verified in SES
        Destination: { ToAddresses: [email] },
        Message: {
          Subject: { Data: subject },
          Body: {
            Text: { Data: textBody },
            Html: { Data: htmlBody }
          }
        }
      }).promise();

      console.log(`Welcome email sent to ${email}`);
    } else {
      console.log("Skipping welcome email because sendWelcomeEmail flag was false or missing.");
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: "success",
        message: "User created successfully and associated with clinic(s).",
        userSub: userSub, // <-- Use the correct userSub variable
      }),
    };

  } catch (error) {
    console.error("Error:", error);
    // Provide more specific error messages
    let errorMessage = error.message || "An unknown error occurred";
    if (error.name === "UsernameExistsException") {
      errorMessage = "A user with this email already exists.";
    } else if (error.name === "InvalidPasswordException") {
      errorMessage = "Password does not meet the requirements.";
    }

    return {
      statusCode: 400, // Use 400 for client-side errors like "user exists"
      headers: corsHeaders,
      body: JSON.stringify({ error: errorMessage }),
    };
  }
};

exports.handler = handler;