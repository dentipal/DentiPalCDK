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

const CLINIC_GROUPS_NORM = new Set(["root", "clinicadmin", "clinicmanager", "clinicviewer"]);

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
      return json(400, { error: "Required fields: email, password" });
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
      return json(401, { error: "Authentication failed. Please check your credentials." });
    }

    // Decode id token (no external deps)
    const idToken = tokens.IdToken!;
    const payloadBase64 = idToken.split(".")[1];
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

    return json(200, responseBody);

  } catch (error: any) {
    console.error("=== ERROR DEBUG ===");
    console.error("Error during login:", error);
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);

    if (error.name === "NotAuthorizedException") {
      return json(401, { error: "Invalid email or password" });
    }
    if (error.name === "UserNotConfirmedException") {
      return json(403, { error: "Email not verified. Please verify your account first." });
    }
    if (error.name === "UserNotFoundException") {
      return json(404, { error: "User not found. Please check your email or register first." });
    }
    if (error.name === "TooManyRequestsException") {
      return json(429, { error: "Too many login attempts. Please try again later." });
    }

    return json(500, {
      error: "Login failed. Please try again.",
      details: error.message,
    });
  }
};