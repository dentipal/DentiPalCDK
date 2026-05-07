import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  AdminGetUserCommand,
  AuthFlowType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  DynamoDBClient,
  ScanCommand,
  ScanCommandInput,
  GetItemCommand,
  QueryCommand,
  BatchGetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamo = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
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
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  console.log("Login request received:", event.body);

  try {
    const loginData: { email?: string; password?: string; userType?: string } = JSON.parse(event.body || "{}");

    if (!loginData.email || !loginData.password) {
      console.warn("Missing required fields");
      return json(event, 400, {
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
      // Cognito returned a challenge instead of tokens. The most common case
      // is NEW_PASSWORD_REQUIRED — fired the first time an admin-invited user
      // signs in with their temporary password. Forward the challenge so the
      // client can prompt for a new password and call /auth/respond-new-password.
      if (authResponse.ChallengeName === "NEW_PASSWORD_REQUIRED") {
        return json(event, 200, {
          status: "challenge",
          challengeName: "NEW_PASSWORD_REQUIRED",
          session: authResponse.Session,
          message: "A new password is required to complete sign-in.",
          // userIdForSrp lets the client target RespondToAuthChallenge precisely
          // even if the original email differs from Cognito's preferred username.
          userIdForSrp: authResponse.ChallengeParameters?.USER_ID_FOR_SRP || email,
        });
      }
      console.warn("Authentication failed for email:", email);
      return json(event, 401, {
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

    // Portal-side validation: reject if user type doesn't match requested portal
    if (loginData.userType) {
      const userIsClinic = isClinicRole(userGroups);
      const requestedClinic = loginData.userType === "clinic";

      if (requestedClinic && !userIsClinic) {
        console.warn(`[login] Portal mismatch: professional user tried clinic login. Email: ${email}`);
        return json(event, 403, {
          error: "Forbidden",
          message: "This is a professional account. Please use the Professional login page.",
          statusCode: 403,
          accountType: "professional",
          timestamp: new Date().toISOString(),
        });
      }

      if (!requestedClinic && userIsClinic) {
        console.warn(`[login] Portal mismatch: clinic user tried professional login. Email: ${email}`);
        return json(event, 403, {
          error: "Forbidden",
          message: "This is a clinic account. Please use the Clinic login page.",
          statusCode: 403,
          accountType: "clinic",
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ─── Ban check ────────────────────────────────────────────────────────
    // Two distinct paths because the ban subject differs by user type:
    //   Branch A — professional: a single GetItem on Bans by their userSub.
    //   Branch B — clinic owner: query CreatedByIndex for every clinic they own,
    //              then BatchGetItem against Bans for all those clinicIds. If
    //              ANY of them is banned, refuse login.
    // Associated clinic users (ClinicAdmin / ClinicManager / ClinicViewer) are
    // not currently checked — they aren't `createdBy` on any clinic, so they
    // sail past Branch B. v1 scope.
    if (process.env.BANS_TABLE) {
      try {
        if (!isClinicRole(userGroups)) {
          // Branch A — professional ban check.
          const profBan = await dynamo.send(new GetItemCommand({
            TableName: process.env.BANS_TABLE,
            Key: marshall({ subjectType: "professional", subjectId: userSub }),
            ProjectionExpression: "subjectId, bannedAt",
          }));
          if (profBan.Item) {
            console.warn("[login] Refused login for banned professional", userSub);
            return json(event, 403, {
              error: "Forbidden",
              message: "Your account has been banned by the DentiPal internal team.",
              statusCode: 403,
              status: "banned",
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          // Branch B — clinic owner: do they own any banned clinic?
          const myClinics = await dynamo.send(new QueryCommand({
            TableName: process.env.CLINICS_TABLE!,
            IndexName: "CreatedByIndex",
            KeyConditionExpression: "createdBy = :u",
            ExpressionAttributeValues: { ":u": { S: userSub } },
            ProjectionExpression: "clinicId",
          }));
          const ownedClinicIds = (myClinics.Items || [])
            .map((it) => it.clinicId?.S)
            .filter((s): s is string => Boolean(s));

          if (ownedClinicIds.length > 0) {
            const banLookup = await dynamo.send(new BatchGetItemCommand({
              RequestItems: {
                [process.env.BANS_TABLE]: {
                  Keys: ownedClinicIds.map((id) => marshall({
                    subjectType: "clinic",
                    subjectId: id,
                  })),
                  ProjectionExpression: "subjectId",
                },
              },
            }));
            const bannedClinicIds = (banLookup.Responses?.[process.env.BANS_TABLE] || [])
              .map((it) => unmarshall(it).subjectId as string);
            if (bannedClinicIds.length > 0) {
              console.warn("[login] Refused clinic login — banned clinics:", bannedClinicIds);
              return json(event, 403, {
                error: "Forbidden",
                message: "Your clinic has been banned by the DentiPal internal team.",
                statusCode: 403,
                status: "banned",
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      } catch (banCheckError) {
        // If the ban check itself fails, log loudly but don't block legitimate
        // users. Cognito AdminDisableUser is the failsafe for professional bans;
        // a one-off DDB hiccup shouldn't lock the entire platform.
        console.error("[login] Ban check failed (allowing login):", banCheckError);
      }
    }

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

    return json(event, 200, {
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
      // Three cases need special-casing, in priority order:
      //   1. banned professional whose Cognito user we disabled → friendly ban msg
      //   2. federated (Google) user trying password login → "use Google Sign-In"
      //   3. anything else → generic "invalid email or password"
      //
      // Order matters: a banned user can ALSO have been EXTERNAL_PROVIDER (we
      // disable them on ban regardless of origin), so the ban check runs FIRST.
      // Otherwise an admin who banned a Google-authed user would still see the
      // misleading "use Google Sign-In" message.
      try {
        const loginData = JSON.parse(event.body || "{}");
        const userInfo = await cognito.send(new AdminGetUserCommand({
          UserPoolId: process.env.USER_POOL_ID!,
          Username: String(loginData.email).toLowerCase(),
        }));

        // (1) Disabled + has a Bans row → banned message.
        // The DB ban check that runs on a successful auth path can't fire here
        // (we never got tokens), so we re-check the Bans table by sub.
        if (userInfo.Enabled === false && process.env.BANS_TABLE) {
          const sub = userInfo.UserAttributes?.find(a => a.Name === "sub")?.Value;
          if (sub) {
            try {
              const banLookup = await dynamo.send(new GetItemCommand({
                TableName: process.env.BANS_TABLE,
                Key: marshall({ subjectType: "professional", subjectId: sub }),
                ProjectionExpression: "subjectId",
              }));
              if (banLookup.Item) {
                return json(event, 403, {
                  error: "Forbidden",
                  message: "Your account has been banned by the DentiPal internal team.",
                  statusCode: 403,
                  status: "banned",
                  timestamp: new Date().toISOString(),
                });
              }
            } catch (banErr) {
              console.warn("[login] Ban re-check on disabled user failed:", banErr);
            }
          }
        }

        // (2) Federated identity that hasn't been banned.
        if (userInfo.UserStatus === "EXTERNAL_PROVIDER") {
          statusCode = 401;
          errorMessage = "Unauthorized";
          details = { message: "This account uses Google Sign-In. Please click the Google button to log in." };
          return json(event, statusCode, { error: errorMessage, statusCode, details, timestamp: new Date().toISOString() });
        }
      } catch {
        // User lookup failed, fall through to generic invalid-credentials message.
      }
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

    return json(event, statusCode, {
      error: errorMessage,
      statusCode,
      details,
      timestamp: new Date().toISOString(),
    });
  }
};