import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminUpdateUserAttributesCommand,
  AdminInitiateAuthCommand,
  AuthFlowType,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, ScanCommand, ScanCommandInput } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamo = new DynamoDBClient({ region: process.env.REGION });

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

const CLINIC_GROUPS_NORM = new Set(["root", "clinicadmin", "clinicmanager", "clinicviewer"]);

function isClinicRole(groups: string[]): boolean {
  return groups.some((g) => CLINIC_GROUPS_NORM.has(g.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

function formatAddressFromItem(item: any): string {
  const get = (k: string): string => (item[k] && item[k].S ? item[k].S : "");
  const parts = [
    get("addressLine1"), get("addressLine2"), get("addressLine3"),
    get("city"), (get("state") || "").trim(), get("pincode"),
  ].filter(Boolean);
  return parts.join(", ") || get("address") || "No address available";
}

/**
 * Verify a Google ID token by calling Google's tokeninfo endpoint.
 * Returns the decoded payload if valid.
 */
async function verifyGoogleToken(idToken: string): Promise<any> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`
  );
  if (!res.ok) {
    throw new Error("Invalid Google token");
  }
  const payload = await res.json() as Record<string, any>;

  // Verify the token was issued for our app
  const expectedClientId = process.env.GOOGLE_CLIENT_ID;
  if (expectedClientId && payload.aud !== expectedClientId) {
    throw new Error("Google token audience mismatch");
  }

  return payload;
}

/**
 * Find Cognito user by email. Returns the username if found, null otherwise.
 */
async function findUserByEmail(email: string): Promise<string | null> {
  const res = await cognito.send(new ListUsersCommand({
    UserPoolId: process.env.USER_POOL_ID!,
    Filter: `email = "${email}"`,
    Limit: 1,
  }));
  if (res.Users && res.Users.length > 0) {
    return res.Users[0].Username || null;
  }
  return null;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { googleToken, userType } = body as {
      googleToken?: string;
      userType?: "clinic" | "professional";
    };

    if (!googleToken) {
      return json(400, {
        error: "Bad Request",
        message: "Missing googleToken",
        statusCode: 400,
      });
    }

    if (!userType || !["clinic", "professional"].includes(userType)) {
      return json(400, {
        error: "Bad Request",
        message: "Missing or invalid userType (must be 'clinic' or 'professional')",
        statusCode: 400,
      });
    }

    // 1. Verify the Google token
    const googlePayload = await verifyGoogleToken(googleToken);
    const email = (googlePayload.email as string).toLowerCase();
    const givenName = googlePayload.given_name || "User";
    const familyName = googlePayload.family_name || "";

    console.log("[googleLogin] Verified Google token for:", email);

    // 2. Check if user already exists
    let username = await findUserByEmail(email);
    let isNewUser = false;

    if (!username) {
      // 3. Create user in Cognito with all required attributes
      isNewUser = true;
      console.log("[googleLogin] Creating new user:", email);

      const tempPassword = `Temp!${Date.now()}#Gx`;
      const group = userType === "clinic" ? "Root" : "AssociateDentist";

      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
        MessageAction: "SUPPRESS", // Don't send welcome email
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "given_name", Value: givenName },
          { Name: "family_name", Value: familyName },
          { Name: "phone_number", Value: "+10000000000" },
          { Name: "address", Value: `userType:${userType}|role:${group.toLowerCase()}|clinic:none` },
        ],
        TemporaryPassword: tempPassword,
      }));

      // Set a permanent password so the user doesn't need to change it
      const permanentPassword = `Google!${Date.now()}#${Math.random().toString(36).slice(2, 10)}`;
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
        Password: permanentPassword,
        Permanent: true,
      }));

      // Add to group
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
        GroupName: group,
      }));

      username = email;
      console.log("[googleLogin] User created and added to group:", group);
    } else {
      console.log("[googleLogin] Existing user found:", username);
    }

    // 4. Get user info to validate portal access
    const userInfo = await cognito.send(new AdminGetUserCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      Username: username!,
    }));

    const userSub = userInfo.UserAttributes?.find(a => a.Name === "sub")?.Value || "";

    // 5. Get user groups
    const { AdminListGroupsForUserCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const groupsRes = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      Username: username!,
    }));
    const userGroups = (groupsRes.Groups || []).map(g => g.GroupName || "");

    // 6. Validate portal access (only for existing users)
    if (!isNewUser) {
      const userIsClinic = isClinicRole(userGroups);
      if (userType === "clinic" && !userIsClinic) {
        return json(403, {
          error: "Forbidden",
          message: "This is a professional account. Please use the Professional login page.",
          statusCode: 403,
        });
      }
      if (userType === "professional" && userIsClinic) {
        return json(403, {
          error: "Forbidden",
          message: "This is a clinic account. Please use the Clinic login page.",
          statusCode: 403,
        });
      }
    }

    // 7. Generate Cognito tokens using ADMIN_USER_PASSWORD_AUTH
    // We need to get the user's password to generate tokens, but we can use admin auth
    const authRes = await cognito.send(new AdminInitiateAuthCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      ClientId: process.env.CLIENT_ID!,
      AuthFlow: "ADMIN_USER_PASSWORD_AUTH" as any,
      AuthParameters: {
        USERNAME: username!,
        // For admin auth we need a way to authenticate - use custom auth or generate tokens differently
      },
    })).catch(() => null);

    // If ADMIN_USER_PASSWORD_AUTH fails (we don't know the password for existing users),
    // we'll use a different approach - get tokens from a custom flow
    // For now, we'll create a temporary auth session

    // Alternative: For Google users, we set a known password pattern
    // and use it for authentication
    if (!authRes?.AuthenticationResult) {
      // Set a new password for the user and auth with it
      const googlePassword = `G00gle!${userSub.slice(0, 8)}#Auth`;
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: username!,
        Password: googlePassword,
        Permanent: true,
      }));

      const retryAuth = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        ClientId: process.env.CLIENT_ID!,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH" as any,
        AuthParameters: {
          USERNAME: username!,
          PASSWORD: googlePassword,
        },
      }));

      const tokens = retryAuth.AuthenticationResult;
      if (!tokens) {
        return json(500, {
          error: "Internal Server Error",
          message: "Failed to generate authentication tokens",
          statusCode: 500,
        });
      }

      // Fetch associated clinics for clinic users
      const associatedClinics = await fetchAssociatedClinics(userSub, userGroups);

      return json(200, {
        status: "success",
        statusCode: 200,
        message: isNewUser ? "Account created and logged in with Google" : "Login successful",
        data: {
          tokens: {
            accessToken: tokens.AccessToken,
            idToken: tokens.IdToken,
            refreshToken: tokens.RefreshToken,
            expiresIn: tokens.ExpiresIn,
            tokenType: tokens.TokenType || "Bearer",
          },
          user: {
            email,
            sub: userSub,
            groups: userGroups,
            associatedClinics,
          },
          isNewUser,
          loginAt: new Date().toISOString(),
        },
      });
    }

    const tokens = authRes.AuthenticationResult;
    const associatedClinics = await fetchAssociatedClinics(userSub, userGroups);

    return json(200, {
      status: "success",
      statusCode: 200,
      message: isNewUser ? "Account created and logged in with Google" : "Login successful",
      data: {
        tokens: {
          accessToken: tokens!.AccessToken,
          idToken: tokens!.IdToken,
          refreshToken: tokens!.RefreshToken,
          expiresIn: tokens!.ExpiresIn,
          tokenType: tokens!.TokenType || "Bearer",
        },
        user: {
          email,
          sub: userSub,
          groups: userGroups,
          associatedClinics,
        },
        isNewUser,
        loginAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error("[googleLogin] Error:", error);
    return json(500, {
      error: "Internal Server Error",
      message: error.message || "Google login failed",
      statusCode: 500,
      timestamp: new Date().toISOString(),
    });
  }
};

async function fetchAssociatedClinics(
  userSub: string,
  userGroups: string[]
): Promise<Array<{ clinicId: string; name: string; address: string }>> {
  const clinics: Array<{ clinicId: string; name: string; address: string }> = [];

  if (!isClinicRole(userGroups)) return clinics;

  const params: ScanCommandInput = {
    TableName: process.env.CLINICS_TABLE!,
    FilterExpression: "contains(AssociatedUsers, :sub)",
    ExpressionAttributeValues: { ":sub": { S: userSub } },
    ProjectionExpression:
      "clinicId, #nm, address, addressLine1, addressLine2, addressLine3, city, #st, pincode",
    ExpressionAttributeNames: { "#nm": "name", "#st": "state" },
  };

  let lastKey = undefined;
  do {
    if (lastKey) params.ExclusiveStartKey = lastKey;
    const page = await dynamo.send(new ScanCommand(params));
    for (const item of page.Items || []) {
      const clinicId = item.clinicId?.S || "";
      if (clinicId) {
        clinics.push({
          clinicId,
          name: item.name?.S || "",
          address: formatAddressFromItem(item),
        });
      }
    }
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  return clinics;
}
