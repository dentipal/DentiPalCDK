import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult
} from "aws-lambda";

import {
  DynamoDBClient,
  ScanCommand,
  ScanCommandInput,
  type AttributeValue,
  type ScanCommandOutput
} from "@aws-sdk/client-dynamodb";

import { extractUserFromBearerToken, isRoot } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    // Extract Bearer token from Authorization header
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;
    const groups = userInfo.groups;

    const queryParams = event.queryStringParameters || {};

    const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
    const state = queryParams.state || undefined;
    const city = queryParams.city || undefined;
    const name = queryParams.name || undefined;

    // Membership scoping pushed into the Scan FilterExpression so DynamoDB
    // doesn't return clinics the caller can't see. Previously this filter
    // ran in JS after the Scan returned, which combined with the unpaginated
    // 50-item Limit silently dropped almost everyone's clinics — the table
    // is scanned in hash order, so the user's rows usually weren't even in
    // the first page.
    const filterExpressions: string[] = [
      "(createdBy = :userSub OR contains(AssociatedUsers, :userSub))"
    ];
    const expressionAttributeValues: Record<string, AttributeValue> = {
      ":userSub": { S: userSub }
    };
    const expressionAttributeNames: Record<string, string> = {};

    if (state) {
      filterExpressions.push("contains(address, :state)");
      expressionAttributeValues[":state"] = { S: state };
    }

    if (city) {
      filterExpressions.push("contains(address, :city)");
      expressionAttributeValues[":city"] = { S: city };
    }

    if (name) {
      filterExpressions.push("contains(#name, :name)");
      expressionAttributeValues[":name"] = { S: name };
      expressionAttributeNames["#name"] = "name";
    }

    // Always hide soft-deleted clinics from this listing.
    filterExpressions.push("attribute_not_exists(deletedAt)");

    const baseScan: ScanCommandInput = {
      TableName: process.env.CLINICS_TABLE,
      FilterExpression: filterExpressions.join(" AND "),
      ExpressionAttributeValues: expressionAttributeValues
    };
    if (Object.keys(expressionAttributeNames).length > 0) {
      baseScan.ExpressionAttributeNames = expressionAttributeNames;
    }

    // Paginate the Scan. DynamoDB applies `Limit` BEFORE `FilterExpression`,
    // so a single Scan call with a membership filter can return zero items
    // while the user actually has matches further into the table.
    const collectedItems: Record<string, AttributeValue>[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
    do {
      const resp: ScanCommandOutput = await dynamoClient.send(new ScanCommand({
        ...baseScan,
        ExclusiveStartKey
      }));
      if (resp.Items?.length) {
        collectedItems.push(...(resp.Items as Record<string, AttributeValue>[]));
      }
      ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey && collectedItems.length < limit);

    const cappedItems = collectedItems.slice(0, limit);

    if (cappedItems.length === 0) {
      return json(event, 200, {
        status: "success",
        clinics: [],
        totalCount: 0,
        message: "No clinics found"
      });
    }

    console.log(
      "🔍 Raw items from DynamoDB:",
      JSON.stringify(cappedItems, null, 2)
    );

    const accessibleClinics = cappedItems.map((item: any) => {
      const createdBy = item.createdBy?.S || null;
      const associatedUsersRaw = item.AssociatedUsers?.L || [];
      const associatedUsers = associatedUsersRaw.map((u: any) => u.S);

      return {
        clinicId: item.clinicId?.S || "",
        name: item.name?.S || "",
        addressLine1: item.addressLine1?.S || "",
        addressLine2: item.addressLine2?.S || "",
        addressLine3: item.addressLine3?.S || "",
        city: item.city?.S || "",
        state: item.state?.S || "",
        pincode: item.pincode?.S || "",
        createdAt: item.createdAt?.S || "",
        updatedAt: item.updatedAt?.S || "",
        createdBy,
        associatedUsers
      };
    });

    console.log(
      `[getUsersClinics] Scoped to ${accessibleClinics.length} accessible clinics for user ${userSub}`
    );

    return json(event, 200, {
      status: "success",
      clinics: accessibleClinics,
      totalCount: accessibleClinics.length,
      filters: {
        state: state || null,
        city: city || null,
        name: name || null,
        limit
      },
      currentUser: {
        userSub,
        isRoot: isRoot(groups),
        groups
      },
      message: `Retrieved ${accessibleClinics.length} clinic(s)`
    });

  } catch (error: any) {
    console.error("❌ Error retrieving clinics:", error);

    return json(event, 500, {
      error: "Failed to retrieve clinics. Please try again.",
      details: error.message
    });
  }
};