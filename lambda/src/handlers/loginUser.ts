import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AuthFlowType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient, ScanCommand, ScanCommandInput } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamo = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

/* ----------------- helpers ----------------- */
const norm = (s: string | undefined): string =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const CLINIC_GROUPS_NORM = new Set(["Root", "ClinicAdmin", "ClinicManager", "ClinicViewer"]);

function isClinicRole(groups: string[] | undefined): boolean {
  const normalized = (groups || []).map(norm);
  const ok = normalized.some((g) => CLINIC_GROUPS_NORM.has(g));
  console.log("[auth] groups raw:", groups, "normalized:", normalized, "isClinicRole:", ok);
  return ok;
}

function formatAddressFromItem(item: any): string {
  // Support new canonical fields and fallback to legacy single `address`
  const get = (k: string): string => (item[k] && item[k].S ? item[k].S : "");
  const parts = [
    get("addressLine1"),
    get("addressLine2"),
    get("addressLine3"),
    get("city"),
    (get("state") || "").trim(),
    get("pincode"),
  ].filter(Boolean);
  const lines = parts.join(", ");
  return lines || get("address") || "No address available";
}
/* ------------------------------------------- */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  console.log("Login request received:", event.body);

  try {
    const loginData: { email?: string; password?: string } = JSON.parse(event.body || "{}");

    if (!loginData.email || !loginData.password) {
      console.warn("Missing required fields");
      return json(400, {
        error: "Bad Request",
        message: "Missing required fields",
        requiredFields: ["email", "password"],
        statusCode: 400,
        timestamp: new Date().toISOString(),
      });
    }

    const email = String(loginData.email).toLowerCase();
    console.log("Authenticating user:", email);

    const authCommand = new InitiateAuthCommand({
      ClientId: process.env.CLIENT_ID,
      AuthFlow: AuthFlowType.USER_PASSWORD_AUTH,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: loginData.password,
      },
    });

    const authResponse = await cognito.send(authCommand);
    const tokens = authResponse.AuthenticationResult;

    if (!tokens) {
      console.warn("Authentication failed for email:", email);
      return json(401, {
        error: "Unauthorized",
        message: "Invalid email or password",
        statusCode: 401,
        timestamp: new Date().toISOString(),
      });
    }

    // Decode access token (no external deps) - use accessToken for authorization
    const accessToken = tokens.AccessToken!;
    const payloadBase64 = accessToken.split(".")[1];
    const decodedPayload = JSON.parse(Buffer.from(payloadBase64, "base64").toString("utf-8"));

    const userSub: string = decodedPayload.sub;
    const userGroups: string[] = decodedPayload["cognito:groups"] || [];

    console.log("=== USER AUTHENTICATION DEBUG ===");
    console.log("User sub:", userSub);
    console.log("User groups:", userGroups);
    console.log("User email:", email);

    const associatedClinics: Array<{ clinicId: string; name: string; address: string }> = [];

    if (isClinicRole(userGroups)) {
      console.log("=== CLINIC RETRIEVAL DEBUG ===");
      console.log("[login] User has clinic role, fetching associated clinics for sub:", userSub);
      console.log("[login] Using table:", process.env.CLINICS_TABLE);

      const params: ScanCommandInput = {
        TableName: process.env.CLINICS_TABLE!,
        FilterExpression: "contains(AssociatedUsers, :sub)",
        ExpressionAttributeValues: { ":sub": { S: userSub } },
        ProjectionExpression:
          "clinicId, #nm, address, addressLine1, addressLine2, addressLine3, city, #st, pincode, AssociatedUsers",
        ExpressionAttributeNames: { "#nm": "name", "#st": "state" },
      };

      console.log("[login] DynamoDB scan params:", JSON.stringify(params, null, 2));

      let lastKey = undefined;
      let totalScannedItems = 0;
      let pageNumber = 1;

      do {
        if (lastKey) {
          params.ExclusiveStartKey = lastKey;
          console.log("[login] Continuing scan from lastKey:", JSON.stringify(lastKey, null, 2));
        }

        console.log(`[login] === PAGE ${pageNumber} SCAN START ===`);
        const page = await dynamo.send(new ScanCommand(params));

        console.log(
          `[login] Page ${pageNumber} results - Count:`,
          page.Count,
          "Items length:",
          (page.Items || []).length,
          "LastEvaluatedKey?",
          !!page.LastEvaluatedKey
        );

        const items = page.Items || [];
        totalScannedItems += items.length;

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const clinicId = item.clinicId?.S || "";
          const name = item.name?.S || "";
          const address = formatAddressFromItem(item);

          let associatedUsersDebug = "N/A";
          if (item.AssociatedUsers) {
            if (item.AssociatedUsers.SS) {
              associatedUsersDebug = `SS: [${item.AssociatedUsers.SS.join(", ")}]`;
            } else if (item.AssociatedUsers.L) {
              const listItems = item.AssociatedUsers.L.map((listItem: any) => {
                if (listItem.S) return listItem.S;
                return JSON.stringify(listItem);
              });
              associatedUsersDebug = `L: [${listItems.join(", ")}]`;
            } else if (item.AssociatedUsers.S) {
              associatedUsersDebug = `S: ${item.AssociatedUsers.S}`;
            } else {
              associatedUsersDebug = `Unknown format: ${JSON.stringify(item.AssociatedUsers)}`;
            }
          }

          console.log(`[login] Item ${i + 1}:`, {
            clinicId,
            name,
            associatedUsers: associatedUsersDebug,
            userSubMatch: associatedUsersDebug.includes(userSub),
          });

          if (clinicId) {
            associatedClinics.push({ clinicId, name, address });
            console.log(`[login] ✓ Added clinic: ${clinicId} - ${name}`);
          } else {
            console.log(`[login] ✗ Skipped clinic (no clinicId):`, name);
          }
        }

        lastKey = page.LastEvaluatedKey;
        pageNumber++;
        console.log(`[login] === PAGE ${pageNumber - 1} SCAN END ===`);
      } while (lastKey);

      console.log("=== FINAL CLINIC RESULTS ===");
      console.log("[login] Total scanned items:", totalScannedItems);
      console.log("[login] Associated clinics found:", associatedClinics.length);
      console.log("[login] Clinic details:", JSON.stringify(associatedClinics, null, 2));
    } else {
      console.log("=== NO CLINIC ACCESS ===");
      console.log("[login] User has no clinic role → skipping clinic scan.");
      console.log("[login] User groups were:", userGroups);
    }

    const responseBody = {
      message: "Login successful",
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
    };

    console.log("=== RESPONSE DEBUG ===");
    console.log("[login] Final response user object:", {
      email: responseBody.user.email,
      sub: responseBody.user.sub,
      groups: responseBody.user.groups,
      clinicsCount: responseBody.user.associatedClinics.length,
    });

    return json(200, {
      status: "success",
      statusCode: 200,
      message: "Login successful",
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
        loginAt: new Date().toISOString(),
      },
    });

  } catch (error: any) {
    console.error("Error during login:", error);
    
    let statusCode = 500;
    let errorMessage = "Internal Server Error";
    let details: any = {};

    if (error.name === "NotAuthorizedException") {
      statusCode = 401;
      errorMessage = "Unauthorized";
      details = { message: "Invalid email or password" };
    } else if (error.name === "UserNotConfirmedException") {
      statusCode = 403;
      errorMessage = "Forbidden";
      details = { message: "Email not verified. Please verify your email first." };
    } else if (error.name === "UserNotFoundException") {
      statusCode = 404;
      errorMessage = "Not Found";
      details = { message: "User with this email does not exist" };
    } else if (error.name === "TooManyRequestsException") {
      statusCode = 429;
      errorMessage = "Too Many Requests";
      details = { message: "Too many login attempts. Please try again later." };
    } else if (error.name === "ResourceNotFoundException") {
      statusCode = 404;
      errorMessage = "Not Found";
      details = { message: "Cognito resource not found" };
    } else if (error.name === "InvalidParameterException") {
      statusCode = 400;
      errorMessage = "Bad Request";
      details = { message: "Invalid request parameters" };
    } else {
      statusCode = 500;
      errorMessage = "Internal Server Error";
      details = { message: error.message || "An unexpected error occurred" };
    }

    return json(statusCode, {
      error: errorMessage,
      statusCode,
      details,
      timestamp: new Date().toISOString(),
    });
  }
};