import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminAddUserToGroupCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminListGroupsForUserCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, ScanCommand, ScanCommandInput } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { corsHeaders } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamo = new DynamoDBClient({ region: process.env.REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
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
 * Exchange a Google authorization code for tokens and return user info.
 * Also accepts a raw ID token (JWT) as a fallback.
 */
async function verifyGoogleToken(
  codeOrToken: string,
  clientRedirectUri?: string
): Promise<Record<string, any>> {
  // If it looks like a JWT (3 dot-separated parts), treat as ID token
  if (codeOrToken.split(".").length === 3) {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(codeOrToken)}`
    );
    if (!res.ok) {
      throw new Error("Invalid Google token");
    }
    const payload = await res.json() as Record<string, any>;
    const expectedClientId = process.env.GOOGLE_CLIENT_ID;
    if (expectedClientId && payload.aud !== expectedClientId) {
      throw new Error("Google token audience mismatch");
    }
    return payload;
  }

  // Otherwise treat as authorization code — exchange it for tokens.
  // The redirect_uri MUST match the one used to obtain the code, so prefer
  // the value the client reports; fall back to env for legacy callers.
  const clientId = process.env.GOOGLE_CLIENT_ID!;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET!;
  const redirectUri =
    clientRedirectUri || process.env.GOOGLE_REDIRECT_URI || "http://localhost:5173/callback";

  const body = new URLSearchParams({
    code: codeOrToken,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error("[googleLogin] Token exchange failed:", errText);
    throw new Error("Failed to exchange Google authorization code");
  }

  const tokenData = await tokenRes.json() as Record<string, any>;
  const idToken = tokenData.id_token as string | undefined;

  if (!idToken) {
    throw new Error("No ID token in Google token response");
  }

  // Decode the ID token payload (base64url)
  const payloadBase64 = idToken.split(".")[1];
  const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf-8"));

  if (payload.aud !== clientId) {
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

/**
 * Generate a deterministic but secure password for Google-authenticated users.
 */
function googlePassword(userSub: string): string {
  return `G00gle!${userSub.slice(0, 8)}#Auth`;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { googleToken, userType, redirectUri } = body as {
      googleToken?: string;
      userType?: "clinic" | "professional";
      redirectUri?: string;
    };

    if (!googleToken) {
      return json(event, 400, {
        error: "Bad Request",
        message: "Missing googleToken",
        statusCode: 400,
      });
    }

    if (!userType || !["clinic", "professional"].includes(userType)) {
      return json(event, 400, {
        error: "Bad Request",
        message: "Missing or invalid userType (must be 'clinic' or 'professional')",
        statusCode: 400,
      });
    }

    // 1. Verify the Google token / exchange auth code
    console.log("[googleLogin] Verifying Google token...");
    const googlePayload = await verifyGoogleToken(googleToken, redirectUri);
    const email = (googlePayload.email as string).toLowerCase();
    const givenName = (googlePayload.given_name as string) || "User";
    const familyName = (googlePayload.family_name as string) || "";

    console.log("[googleLogin] Verified Google token for:", email);

    // 2. Check if user already exists in Cognito
    let username = await findUserByEmail(email);
    let isNewUser = false;
    let userSub = "";

    if (!username) {
      // 3. Create new user in Cognito with all required attributes
      isNewUser = true;
      console.log("[googleLogin] Creating new user:", email);

      const group = userType === "clinic" ? "Root" : "AssociateDentist";
      const tempPassword = `Temp!${Date.now()}#Gx`;

      await cognito.send(new AdminCreateUserCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
        MessageAction: "SUPPRESS",
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

      // Get the sub for password generation
      const newUserInfo = await cognito.send(new AdminGetUserCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
      }));
      userSub = newUserInfo.UserAttributes?.find(a => a.Name === "sub")?.Value || "";

      // Set permanent password
      const pwd = googlePassword(userSub);
      await cognito.send(new AdminSetUserPasswordCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: email,
        Password: pwd,
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

      // Get user sub
      const existingUserInfo = await cognito.send(new AdminGetUserCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        Username: username,
      }));
      userSub = existingUserInfo.UserAttributes?.find(a => a.Name === "sub")?.Value || "";
    }

    // 4. Get user groups
    const groupsRes = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      Username: username!,
    }));
    const userGroups = (groupsRes.Groups || []).map(g => g.GroupName || "");

    // 5. Validate portal access (only for existing users)
    if (!isNewUser) {
      const userIsClinic = isClinicRole(userGroups);
      if (userType === "clinic" && !userIsClinic) {
        return json(event, 403, {
          error: "Forbidden",
          message: "This is a professional account. Please use the Professional login page.",
          statusCode: 403,
        });
      }
      if (userType === "professional" && userIsClinic) {
        return json(event, 403, {
          error: "Forbidden",
          message: "This is a clinic account. Please use the Clinic login page.",
          statusCode: 403,
        });
      }
    }

    // 6. Authenticate to get Cognito tokens
    let tokens;

    if (isNewUser) {
      // New user — use password auth (password was set during creation)
      const pwd = googlePassword(userSub);
      const authRes = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        ClientId: process.env.CLIENT_ID!,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH" as any,
        AuthParameters: { USERNAME: username!, PASSWORD: pwd },
      }));
      tokens = authRes.AuthenticationResult;
    } else {
      // Existing user — use CUSTOM_AUTH to get tokens WITHOUT changing password
      const initRes = await cognito.send(new AdminInitiateAuthCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        ClientId: process.env.CLIENT_ID!,
        AuthFlow: "CUSTOM_AUTH" as any,
        AuthParameters: { USERNAME: username! },
      }));

      const challengeRes = await cognito.send(new AdminRespondToAuthChallengeCommand({
        UserPoolId: process.env.USER_POOL_ID!,
        ClientId: process.env.CLIENT_ID!,
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: initRes.Session!,
        ChallengeResponses: {
          USERNAME: username!,
          ANSWER: "google-verified",
        },
      }));
      tokens = challengeRes.AuthenticationResult;
    }

    if (!tokens) {
      return json(event, 500, {
        error: "Internal Server Error",
        message: "Failed to generate authentication tokens",
        statusCode: 500,
      });
    }

    // 7. Fetch associated clinics for clinic users
    const associatedClinics = await fetchAssociatedClinics(userSub, userGroups);

    console.log("[googleLogin] Login successful for:", email, "isNewUser:", isNewUser);

    return json(event, 200, {
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
  } catch (error: any) {
    console.error("[googleLogin] Error:", error);
    return json(event, 500, {
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
