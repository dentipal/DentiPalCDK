import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  GetItemCommand,
  DeleteItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
  AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";

// --- Configuration ---
const REGION = process.env.AWS_REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });
const cognitoIdp = new CognitoIdentityProviderClient({ region: REGION });

const MESSAGES_TABLE = process.env.MESSAGES_TABLE || "DentiPal-Messages";
const CONVOS_TABLE = process.env.CONVOS_TABLE || "DentiPal-Conversations";
const CONNS_TABLE = process.env.CONNS_TABLE || "DentiPal-Connections";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const WS_ENDPOINT = process.env.WS_ENDPOINT; // https://...execute-api.../prod

// --- Utility Functions ---
const nowMs = (): number => Date.now();
const isoNow = (): string => new Date().toISOString();

function makeConversationId(clinicId: string | number, professionalSub: string): string {
  const a = `clinic#${String(clinicId).trim()}`;
  const b = `prof#${String(professionalSub).trim()}`;
  return [a, b].sort().join("|");
}

// --- Name Resolution Helpers ---

function pickAttr(attrs: AttributeType[] | undefined, name: string): string {
  const a = (attrs || []).find((x) => x.Name === name);
  return a ? a.Value || "" : "";
}

/** Look up professional display name from Cognito by sub */
async function getProfessionalName(sub: string): Promise<string> {
  try {
    const out = await cognitoIdp.send(
      new AdminGetUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: sub,
      })
    );
    const given = pickAttr(out.UserAttributes, "given_name");
    const fullname = pickAttr(out.UserAttributes, "name");
    const family = pickAttr(out.UserAttributes, "family_name");
    const email = pickAttr(out.UserAttributes, "email");

    return (
      given?.trim() ||
      fullname?.trim() ||
      [given, family].filter(Boolean).join(" ").trim() ||
      (email && email.split("@")[0]) ||
      `User ${String(sub).slice(0, 6)}`
    );
  } catch (e) {
    console.error("getProfessionalName failed:", { sub, error: (e as Error).message });
    return `User ${String(sub).slice(0, 6)}`;
  }
}

/** Look up clinic display name from DentiPal-Clinics table, fallback to Connections table */
async function getClinicName(clinicId: string): Promise<string> {
  // Try Clinics table first (most reliable)
  try {
    const result = await ddb.send(
      new GetItemCommand({
        TableName: CLINICS_TABLE,
        Key: { clinicId: { S: clinicId } },
      })
    );
    const name =
      result.Item?.clinicName?.S ||
      result.Item?.name?.S ||
      result.Item?.businessName?.S;
    if (name?.trim()) return name.trim();
  } catch (e) {
    console.warn("Clinics table lookup failed:", { clinicId, error: (e as Error).message });
  }

  // Fallback: check active connections for display name
  try {
    const q = await ddb.send(
      new QueryCommand({
        TableName: CONNS_TABLE,
        KeyConditionExpression: "userKey = :uk",
        ExpressionAttributeValues: { ":uk": { S: `clinic#${clinicId}` } },
      })
    );
    const items = q.Items || [];
    if (items.length) {
      const best = items.reduce((a, b) => {
        const an = Number(a.connectedAt?.N || 0);
        const bn = Number(b.connectedAt?.N || 0);
        return an >= bn ? a : b;
      });
      const display = best.display?.S?.trim();
      if (display) return display;
    }
  } catch (e) {
    console.warn("Connections lookup failed:", { clinicId, error: (e as Error).message });
  }

  return `Clinic ${clinicId.slice(0, 6)}`;
}

async function getConnections(userKey: string): Promise<string[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CONNS_TABLE,
      KeyConditionExpression: "userKey = :uk",
      ExpressionAttributeValues: { ":uk": { S: userKey } },
    })
  );
  return (out.Items || [])
    .map((i) => i.connectionId?.S)
    .filter((cid): cid is string => !!cid);
}

// Define the shape of the payload sent over WebSocket
interface WsPayload {
  type: "message";
  conversationId: string;
  messageId: string;
  senderKey: string;
  senderName: string;
  content: string;
  timestamp: string;
  messageType: "system";
  clinicId: string | number;
  professionalSub: string;
  message: Omit<WsPayload, 'type' | 'message'>;
}

async function sendToConnections(conns: string[], payload: WsPayload): Promise<void> {
  if (!conns.length || !WS_ENDPOINT) {
    if (!WS_ENDPOINT) console.error("[event-to-message] WS_ENDPOINT is not set — cannot push real-time notifications");
    return;
  }
  const client = new ApiGatewayManagementApiClient({ endpoint: WS_ENDPOINT });
  const dataToSend = Buffer.from(JSON.stringify(payload));

  await Promise.all(
    conns.map(async (cid) => {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: cid,
            Data: dataToSend,
          })
        );
      } catch (err) {
        if (err instanceof Error && err.name === "GoneException") {
          console.log(`Gone connection: ${cid}, cleaning up`);
          // Clean up stale connection
          try {
            // Find userKey for this connection to delete it
            const q = await ddb.send(
              new QueryCommand({
                TableName: CONNS_TABLE,
                IndexName: "connectionId-index",
                KeyConditionExpression: "connectionId = :cid",
                ExpressionAttributeValues: { ":cid": { S: cid } },
              })
            );
            for (const item of q.Items || []) {
              await ddb.send(
                new DeleteItemCommand({
                  TableName: CONNS_TABLE,
                  Key: {
                    userKey: { S: item.userKey.S! },
                    connectionId: { S: cid },
                  },
                })
              );
            }
          } catch (cleanupErr) {
            console.warn(`Failed to clean up gone connection ${cid}:`, (cleanupErr as Error).message);
          }
        } else if (err instanceof Error) {
          console.error(`Send failed ${cid}:`, err.message);
        } else {
          console.error(`Send failed ${cid}: An unknown error occurred`);
        }
      }
    })
  );
}

// --- Event Definitions ---

interface ShiftDetails {
  role?: string;
  date?: string;
  rate?: number;
  startTime?: string;
  endTime?: string;
  location?: string;
  jobType?: string;
}

// Define the structure expected from EventBridge 'detail'
interface EventDetail {
  eventType: "shift-applied" | "invite-accepted" | "shift-cancelled" | "shift-scheduled";
  clinicId: string; // Changed to string based on makeConversationId usage with string interpolation
  professionalSub: string;
  shiftDetails?: ShiftDetails;
}

// Define the structure of the incoming EventBridge event
interface EventBridgeEvent {
  detail: EventDetail;
  // Other standard EB fields omitted for brevity: id, source, account, time, region, resources
}


// --- Main Handler ---

export const handler = async (event: EventBridgeEvent): Promise<{ statusCode: number }> => {
  try {
    console.log("EventBridge system-message event:", JSON.stringify(event));

    const { detail } = event;
    const { clinicId, professionalSub, shiftDetails = {} } = detail;
    const eventType = detail.eventType as EventDetail['eventType'];

    if (!clinicId || !professionalSub) {
      throw new Error("Missing clinicId or professionalSub in event detail");
    }

    const conversationId = makeConversationId(clinicId, professionalSub);
    const messageId = `${nowMs()}-system-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const timestamp = isoNow();

    // --- Resolve real display names from Cognito / Clinics table ---
    const [profName, clinicName] = await Promise.all([
      getProfessionalName(professionalSub),
      getClinicName(clinicId),
    ]);

    // --- Decide who this message is FROM ---
    let content = "";
    let senderKey = "system#denti-pal";
    let senderName = "System";
    let fromClinic = false;

    const role = shiftDetails.role || "Professional";
    const date = shiftDetails.date || "TBD";
    const rate = shiftDetails.rate ? `$${shiftDetails.rate}/hr` : "";
    const time = shiftDetails.startTime && shiftDetails.endTime
      ? `${shiftDetails.startTime} - ${shiftDetails.endTime}`
      : shiftDetails.startTime || "";
    const location = shiftDetails.location || "";

    // Build detail lines
    const details: string[] = [];
    details.push(`📋 Role: ${role}`);
    details.push(`📅 Date: ${date}`);
    if (time) details.push(`🕐 Time: ${time}`);
    if (rate) details.push(`💰 Rate: ${rate}`);
    if (location) details.push(`📍 Location: ${location}`);

    switch (eventType) {
      case "shift-applied":
        senderKey = `prof#${professionalSub}`;
        senderName = profName;
        fromClinic = false;
        content = `Shift Applied!\n${details.join("\n")}\n\nPlease confirm this application.`;
        break;

      case "invite-accepted":
        senderKey = `prof#${professionalSub}`;
        senderName = profName;
        fromClinic = false;
        content = `Invite Accepted!\n${details.join("\n")}`;
        break;

      case "shift-cancelled":
        senderKey = `clinic#${clinicId}`;
        senderName = clinicName;
        fromClinic = true;
        content = `Shift Cancelled\n${details.join("\n")}`;
        break;

      case "shift-scheduled":
        senderKey = `clinic#${clinicId}`;
        senderName = clinicName;
        fromClinic = true;
        content = `Shift Scheduled! ✅\n${details.join("\n")}\n\nQuestions? Reply here!`;
        break;

      default:
        throw new Error(`Unknown eventType: ${eventType}`);
    }

    // --- Store message in DentiPal-Messages ---
    await ddb.send(
      new PutItemCommand({
        TableName: MESSAGES_TABLE,
        Item: {
          conversationId: { S: conversationId },
          messageId: { S: messageId },
          senderKey: { S: senderKey },
          content: { S: content },
          timestamp: { S: timestamp },
          type: { S: "system" },
        },
      })
    );

    // --- Upsert / update conversation aggregate ---
    const unreadAttr = fromClinic ? "profUnread" : "clinicUnread";
    const otherUnreadAttr = fromClinic ? "clinicUnread" : "profUnread";

    await ddb.send(
      new UpdateItemCommand({
        TableName: CONVOS_TABLE,
        Key: { conversationId: { S: conversationId } },
        UpdateExpression:
          "SET clinicKey = :ck, profKey = :pk, " +
          "clinicName = :cname, profName = :pname, " +
          "lastMessageAt = :lma, lastPreview = :lp, " +
          "#unread = if_not_exists(#unread, :zero) + :inc, " +
          "#otherUnread = :zero",
        ExpressionAttributeNames: {
          "#unread": unreadAttr,
          "#otherUnread": otherUnreadAttr,
        },
        ExpressionAttributeValues: {
          ":ck": { S: `clinic#${clinicId}` },
          ":pk": { S: `prof#${professionalSub}` },
          ":cname": { S: clinicName },
          ":pname": { S: profName },
          ":lma": { N: String(nowMs()) },
          ":lp": { S: content.slice(0, 100) },
          ":zero": { N: "0" },
          ":inc": { N: "1" },
        } as Record<string, AttributeValue>,
      })
    );

    // --- Push real-time message to BOTH sides ---
    const profKey = `prof#${professionalSub}`;
    const clinicKey = `clinic#${clinicId}`;
    const [profConns, clinicConns] = await Promise.all([
      getConnections(profKey),
      getConnections(clinicKey),
    ]);

    const payload: WsPayload = {
      type: "message",
      conversationId,
      messageId,
      senderKey,
      senderName,
      content,
      timestamp,
      messageType: "system",
      clinicId,
      professionalSub,
      message: {
        conversationId,
        messageId,
        senderKey,
        senderName,
        content,
        timestamp,
        messageType: "system",
        clinicId,
        professionalSub,
      },
    };

    const allConns = Array.from(new Set([...profConns, ...clinicConns]));
    await sendToConnections(allConns, payload);

    console.log(`System message sent for ${eventType} in ${conversationId} (clinic: ${clinicName}, prof: ${profName})`);
    return { statusCode: 200 };
  } catch (err) {
    console.error("Error in system-message lambda:", err);
    throw err;
  }
};