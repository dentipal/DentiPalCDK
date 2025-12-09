import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";

// --- Configuration ---
const REGION = process.env.AWS_REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });

const MESSAGES_TABLE = process.env.MESSAGES_TABLE || "DentiPal-Messages";
const CONVOS_TABLE = process.env.CONVOS_TABLE || "DentiPal-Conversations";
const CONNS_TABLE = process.env.CONNS_TABLE || "DentiPal-Connections";
const WS_ENDPOINT = process.env.WS_ENDPOINT; // https://...execute-api.../prod

// --- Utility Functions ---
const nowMs = (): number => Date.now();
const isoNow = (): string => new Date().toISOString();

function makeConversationId(clinicId: string | number, professionalSub: string): string {
  const a = `clinic#${String(clinicId).trim()}`;
  const b = `prof#${String(professionalSub).trim()}`;
  return [a, b].sort().join("|");
}

async function getConnections(userKey: string): Promise<string[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: CONNS_TABLE,
      KeyConditionExpression: "userKey = :uk",
      ExpressionAttributeValues: { ":uk": { S: userKey } },
    })
  );
  // Type guard assertion for safety in mapping
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
  message: Omit<WsPayload, 'type' | 'message'>; // Nested structure defined in JS source
}

async function sendToConnections(conns: string[], payload: WsPayload): Promise<void> {
  if (!conns.length || !WS_ENDPOINT) return;
  // The client needs the specific endpoint configuration
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
        // Use 'instanceof Error' for type safety in TS
        if (err instanceof Error && err.name === "GoneException") {
          console.log(`Gone: ${cid}`);
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
    const eventType = detail.eventType as EventDetail['eventType']; // Cast to the known literal types

    if (!clinicId || !professionalSub) {
      // Throwing an Error here satisfies the implicit return type of the handler if it fails early
      throw new Error("Missing clinicId or professionalSub in event detail");
    }

    const conversationId = makeConversationId(clinicId, professionalSub);
    // Use crypto for better randomness in TS environments like Node 14+ if available, otherwise stick with Math.random()
    const messageId = `${nowMs()}-system-${Math.random()
      .toString(36)
      .slice(2, 7)}`;
    const timestamp = isoNow();

    // --- Decide who this message is FROM ---
    let content = "";
    let senderKey = "system#denti-pal";
    let senderName = "System";
    let fromClinic = false;

    const role = shiftDetails.role || "Professional";
    const date = shiftDetails.date || "TBD";
    // Use optional chaining and template literals safely for rate display
    const rate = shiftDetails.rate ? `$${shiftDetails.rate}/hr` : "";
    const extras = rate ? ` at ${rate}` : "";

    switch (eventType) {
      case "shift-applied":
        senderKey = `prof#${professionalSub}`;
        senderName = "Professional";
        fromClinic = false;
        content = `Shift applied: ${role} on ${date}${extras}. Confirm?`;
        break;

      case "invite-accepted":
        senderKey = `prof#${professionalSub}`;
        senderName = "Professional";
        fromClinic = false;
        content = `Invite accepted: ${role} on ${date}${extras}.`;
        break;

      case "shift-cancelled":
        senderKey = `clinic#${clinicId}`;
        senderName = "Clinic";
        fromClinic = true;
        content = `Shift cancelled: ${role} on ${date}.`;
        break;

      case "shift-scheduled":
        senderKey = `clinic#${clinicId}`;
        senderName = "Clinic";
        fromClinic = true;
        content = `Shift scheduled: ${role} on ${date}${extras}. Questions? Reply here!`;
        break;

      default:
        // Ensures exhaustiveness check if needed, but the cast above handles this
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

    // DynamoDB SDK v3 UpdateItem requires ExpressionAttributeNames for reserved words like 'lastMessageAt' if used in Expression
    await ddb.send(
      new UpdateItemCommand({
        TableName: CONVOS_TABLE,
        Key: { conversationId: { S: conversationId } },
        UpdateExpression:
          "SET clinicKey = :ck, profKey = :pk, " +
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
          ":lma": { N: String(nowMs()) },
          ":lp": { S: content.slice(0, 100) },
          ":zero": { N: "0" },
          ":inc": { N: "1" },
        } as Record<string, AttributeValue>, // Explicitly type the values object
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
      // Mirroring the nested 'message' object structure from the original JS code
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

    console.log(`System message sent for ${eventType} in ${conversationId}`);
    return { statusCode: 200 };
  } catch (err) {
    console.error("Error in system-message lambda:", err);
    // Re-throw the error so AWS Lambda marks the invocation as a failure
    throw err;
  }
};