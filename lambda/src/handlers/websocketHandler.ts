import {
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand,
    QueryCommand,
    DeleteItemCommand,
    GetItemCommand,
    ScanCommand,
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

import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { 
    APIGatewayProxyEventV2, 
    APIGatewayProxyResultV2, 
    APIGatewayEventRequestContextV2
} from "aws-lambda"; 

// Define a type assertion interface for the requestContext when used in a WebSocket API.
interface WebSocketRequestContext extends APIGatewayEventRequestContextV2 {
    connectionId: string;
}

// Define a type assertion interface for the event when used in a WebSocket API.
interface WebSocketAPIGatewayEventV2 extends APIGatewayProxyEventV2 {
    requestContext: WebSocketRequestContext;
}

// ============== CONFIG & TYPE DEFINITIONS ==============
// All environment variables are injected by the CDK stack
const REGION = process.env.AWS_REGION || "us-east-1";
const MESSAGES_TABLE = process.env.MESSAGES_TABLE!;
const CONNS_TABLE = process.env.CONNS_TABLE!;
const CONVOS_TABLE = process.env.CONVOS_TABLE!;
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-V5-ProfessionalProfiles";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-V5-Clinic-Profiles";
const PROFILE_IMAGES_BUCKET = process.env.PROFILE_IMAGES_BUCKET || "";
const CLINIC_OFFICE_IMAGES_BUCKET = process.env.CLINIC_OFFICE_IMAGES_BUCKET || "";

const ddb = new DynamoDBClient({ region: REGION });
const cognitoIdp = new CognitoIdentityProviderClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const MAX_LEN = 1000;

// simple in-memory name cache (warm Lambda only)
const nameCache = new Map<string, string>(); // keys: "prof#<sub>" or "clinic#<id>" -> display

interface UserClaims {
    userType: "Clinic" | "Professional";
    sub: string;
    clinicId?: string;
    isRoot?: boolean; // Root users can connect without clinicId (super-admin)
    email: string;
    name: string;
}

// ============== HELPERS ==============
const nowMs = (): number => Date.now();
const isoNow = (): string => new Date().toISOString();

function makeConversationId(clinicId: string, professionalSub: string): string {
    const a = `clinic#${String(clinicId).trim()}`;
    const b = `prof#${String(professionalSub).trim()}`;
    return [a, b].sort().join("|");
}

function userKeyFromClaims(claims: UserClaims): string {
    if (claims.userType === "Clinic") {
        if (!claims.clinicId) {
            throw new Error("Missing clinicId for Clinic user");
        }
        return `clinic#${claims.clinicId}`;
    }
    return `prof#${claims.sub}`;
}

function wsClientFromEvent(event: WebSocketAPIGatewayEventV2): ApiGatewayManagementApiClient {
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    // The endpoint construction is crucial for API Gateway Management
    return new ApiGatewayManagementApiClient({
        region: REGION,
        endpoint: `https://${domain}/${stage}`,
    });
}

async function send(client: ApiGatewayManagementApiClient, connectionId: string, payload: any): Promise<void> {
    try {
        await client.send(
            new PostToConnectionCommand({
                ConnectionId: connectionId,
                Data: Buffer.from(JSON.stringify(payload)),
            })
        );
    } catch (err) {
        if ((err as Error).name === "GoneException") {
            console.log("Connection gone, cleaning up:", connectionId);
            // Clean up stale connection from DynamoDB
            try {
                const q = await ddb.send(
                    new QueryCommand({
                        TableName: CONNS_TABLE,
                        IndexName: "connectionId-index",
                        KeyConditionExpression: "connectionId = :cid",
                        ExpressionAttributeValues: { ":cid": { S: connectionId } },
                    })
                );
                await Promise.all(
                    (q.Items || []).map((item) =>
                        ddb.send(
                            new DeleteItemCommand({
                                TableName: CONNS_TABLE,
                                Key: {
                                    userKey: { S: item.userKey.S! },
                                    connectionId: { S: connectionId },
                                },
                            })
                        )
                    )
                );
            } catch (cleanupErr) {
                console.warn("Failed to clean up gone connection:", connectionId, (cleanupErr as Error).message);
            }
            return; // Do NOT re-throw GoneException
        }
        console.error("PostToConnection failed", {
            error: (err as Error).message,
            stack: (err as Error).stack,
        });
        throw err;
    }
}

function pickAttr(attrs: AttributeType[] | undefined, name: string): string {
    const a = (attrs || []).find((x) => x.Name === name);
    return a ? a.Value || "" : "";
}

function sanitizeDisplayName(v: string | undefined): string {
    if (!v) return "";
    return String(v).trim();
}

function displayFromTokenPayload(payload: any): string {
    const gn = sanitizeDisplayName(payload.given_name);
    const nm = sanitizeDisplayName(payload.name);
    const em = sanitizeDisplayName(payload.email);
    return gn || nm || (em && em.split("@")[0]) || "";
}

// Get human name for a professional from Cognito (cached)
async function getCognitoNameBySub(sub: string): Promise<string> {
    const cacheKey = `prof#${sub}`;
    if (nameCache.has(cacheKey)) return nameCache.get(cacheKey)!;

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

        const display =
            sanitizeDisplayName(given) ||
            sanitizeDisplayName(fullname) ||
            sanitizeDisplayName([given, family].filter(Boolean).join(" ")) ||
            sanitizeDisplayName(email && email.split("@")[0]) ||
            `User ${String(sub).slice(0, 6)}`;

        nameCache.set(cacheKey, display);
        return display;
    } catch (e) {
        console.error("getCognitoNameBySub failed", { sub, error: (e as Error).message });
        const fallback = `User ${String(sub).slice(0, 6)}`;
        nameCache.set(cacheKey, fallback);
        return fallback;
    }
}

// Try to grab a human display for a clinic — Clinics table first, then active connections
async function getClinicDisplayByKey(clinicKey: string): Promise<string> {
    if (!clinicKey) return "";
    if (nameCache.has(clinicKey)) return nameCache.get(clinicKey)!;

    const clinicId = clinicKey.replace(/^clinic#/, "");

    // 1. Try DentiPal-Clinics table (most reliable — works even when clinic is offline)
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
        if (name?.trim()) {
            nameCache.set(clinicKey, name.trim());
            return name.trim();
        }
    } catch (e) {
        console.warn("Clinics table lookup failed for", clinicId, (e as Error).message);
    }

    // 2. Fallback: check active connections for display name
    try {
        const q = await ddb.send(
            new QueryCommand({
                TableName: CONNS_TABLE,
                KeyConditionExpression: "userKey = :uk",
                ExpressionAttributeValues: { ":uk": { S: clinicKey } },
            })
        );
        const items = q.Items || [];
        if (items.length) {
            const best = items.reduce((a, b) => {
                const an = Number(a.connectedAt?.N || 0);
                const bn = Number(b.connectedAt?.N || 0);
                return an >= bn ? a : b;
            });
            const display =
                (best.display && sanitizeDisplayName(best.display.S)) || "";
            if (display) {
                nameCache.set(clinicKey, display);
                return display;
            }
        }
    } catch (e) {
        console.warn("Connections lookup failed for", clinicKey, (e as Error).message);
    }

    // 3. Last resort fallback
    const fallback = `Clinic ${clinicId.slice(0, 6)}`;
    nameCache.set(clinicKey, fallback);
    return fallback;
}

// ============== ACCESS TOKEN DECODING UTILITIES (Adapted) ==============

/**
 * Extracts and decodes the JWT payload from the token string.
 * @param token - The raw JWT (Access Token).
 * @returns Decoded JWT claims object.
 * @throws Error if token format is invalid or decoding fails.
 */
function extractAndDecodeAccessTokenPayload(token: string): Record<string, any> {
    const tokenParts = token.split(".");
    if (tokenParts.length !== 3) {
        throw new Error("Invalid access token format (expected 3 parts)");
    }

    try {
        // Decode the payload (second part of JWT)
        const payload = tokenParts[1];
        // Base64 URL decode
        const decoded = Buffer.from(payload, "base64url").toString("utf-8");
        return JSON.parse(decoded);
    } catch (error) {
        throw new Error("Failed to decode access token payload");
    }
}

/**
 * Extracts user information and groups from decoded JWT claims.
 * Also performs token_use validation.
 * @param claims - Decoded JWT claims object
 * @returns Normalized UserClaims object
 * @throws Error if sub is missing or token_use is incorrect
 */
function extractUserInfoFromAccessTokenClaims(claims: Record<string, any>): UserClaims {
    if (!claims.sub) {
        throw new Error("User sub not found in token claims");
    }
    
    // Crucial check: must be an Access Token
    if (claims.token_use !== 'access') {
        throw new Error(`Invalid token type: Expected 'access', got '${claims.token_use}'`);
    }

    const groupsClaim = claims['cognito:groups'];
    let groups: string[] = [];
    
    if (typeof groupsClaim === 'string') {
        // Handle comma-separated string (common in Cognito access token)
        groups = groupsClaim.split(',').map((g: string) => g.trim()).filter((g: string) => g.length > 0);
    } else if (Array.isArray(groupsClaim)) {
        groups = groupsClaim;
    }

    // Determine user type based on groups
    let userType: "Professional" | "Clinic" = "Professional";
    if (groups.some((g) => CLINIC_GROUPS.has(g))) userType = "Clinic";
    else if (groups.some((g) => PROFESSIONAL_GROUPS.has(g))) userType = "Professional";
    // If no specific group is matched, it defaults to Professional

    const displayName = displayFromTokenPayload(claims);

    return {
        sub: claims.sub,
        userType: userType,
        email: claims.email || "",
        name: displayName,
        clinicId: claims['custom:clinicId'] as string | undefined, // May be undefined/null
        isRoot: groups.includes("Root"),
    } as UserClaims;
}


// ============== GROUP DEFINITIONS (Remains the same) ==============
const CLINIC_GROUPS = new Set([
    "ClinicAdmin",
    "ClinicManager",
    "ClinicViewer",
    "Root",
]);
const PROFESSIONAL_GROUPS = new Set([
    "AssociateDentist",
    "DentalAssistant",
    "Dental Hygienist",
    "DualRoleFrontDA",
    "ExpandedFunctionsDA",
]);

async function claimsFromConnection(event: WebSocketAPIGatewayEventV2): Promise<UserClaims> {
    const connectionId = event.requestContext.connectionId;
    const q = await ddb.send(
        new QueryCommand({
            TableName: CONNS_TABLE,
            IndexName: "connectionId-index",
            KeyConditionExpression: "connectionId = :cid",
            ExpressionAttributeValues: { ":cid": { S: connectionId } },
        })
    );
    const item = q.Items && q.Items[0];
    if (!item) {
        console.error("No connection found for connectionId:", { connectionId });
        throw new Error("Missing Authorization");
    }

    const userKey = item.userKey.S!;
    const display = (item.display && item.display.S) || "";
    const sub = (item.sub && item.sub.S) || "";
    const email = (item.email && item.email.S) || "";

    if (userKey.startsWith("clinic#")) {
        return {
            userType: "Clinic",
            clinicId: userKey.slice(7),
            sub,
            email,
            name: display,
        };
    }
    if (userKey.startsWith("prof#")) {
        return {
            userType: "Professional",
            clinicId: undefined,
            sub: userKey.slice(5),
            email,
            name: display,
        };
    }
    console.error("Invalid userKey:", { userKey });
    throw new Error("Invalid userKey");
}

async function validateToken(event: WebSocketAPIGatewayEventV2): Promise<UserClaims> {
    const route = event.requestContext.routeKey;

    if (route === "$connect") {
        const qpToken = event.queryStringParameters?.token || null; 
        const token = qpToken?.trim() || "";
        if (!token) {
            console.error("Missing token in query parameters for $connect");
            throw new Error("Missing token");
        }
        
        // --- Access Token Validation ---
        const claims = await (async () => {
            try {
                const payload = extractAndDecodeAccessTokenPayload(token);
                return extractUserInfoFromAccessTokenClaims(payload);
            } catch (err) {
                console.error("Access Token decoding failed:", {
                    error: (err as Error).message,
                });
                throw new Error("Invalid Access Token");
            }
        })();
        // ---------------------------------
        
        let clinicId: string | undefined = claims.clinicId;
        
        if (!clinicId) {
            // Check query string parameters as a fallback, especially for Clinic users
            clinicId = event.queryStringParameters?.clinicId || undefined;
        }


        if (claims.userType === "Clinic" && !clinicId) {
            console.error(
                "Missing clinicId for Clinic user in token or query parameters during $connect"
            );
            throw new Error("Clinic user requires clinicId");
        }

        return {
            ...claims,
            clinicId: clinicId,
        } as UserClaims;
    } else {
        // For non-$connect routes, we primarily rely on the stored connection claims
        let claims = await claimsFromConnection(event);

        let bodyToken: string | null = null,
            bodyClinicId: string | null = null;
        try {
            const body = JSON.parse(event.body || "{}");
            // Explicitly cast properties read from JSON.parse to string for safety
            bodyToken = (body.token as string | undefined) || null; 
            bodyClinicId = (body.clinicId as string | undefined) || null;
        } catch {
            console.error("Failed to parse event.body:", { body: event.body });
        }

        if (bodyToken) {
            // Optional re-verification using token in body
            const tokenClaims = await (async () => {
                try {
                    const payload = extractAndDecodeAccessTokenPayload(bodyToken);
                    return extractUserInfoFromAccessTokenClaims(payload);
                } catch (err) {
                    console.error("Access Token decoding failed in body:", {
                        error: (err as Error).message,
                    });
                    throw new Error("Invalid Access Token in body");
                }
            })();

            if (claims.userType === "Clinic") {
                const tokenClinicId = bodyClinicId || tokenClaims.clinicId || null;
                if (tokenClinicId && tokenClinicId !== claims.clinicId) {
                    console.error("Token clinicId does not match connection clinicId", {
                        tokenClinicId,
                        connectionClinicId: claims.clinicId,
                    });
                    throw new Error("Invalid clinicId for this connection");
                }
                claims.clinicId = (claims.clinicId || tokenClinicId) as string | undefined; 
            }
            if (!claims.sub) {
                claims.sub = tokenClaims.sub as string;
            }
            // Update display name and email if the body token provides fresher data
            claims.name = claims.name || tokenClaims.name;
            claims.email = claims.email || tokenClaims.email || "";
        }

        // Root users can operate without clinicId
        if (claims.userType === "Clinic" && !claims.clinicId && !claims.isRoot) {
            console.error("Missing clinicId for Clinic user in connection or body");
            throw new Error("Clinic user requires clinicId");
        }

        return claims;
    }
}

async function putConnection(userKey: string, connectionId: string, userType: string, display: string, sub: string, email: string = "") {
    const ttl = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // 24h
    await ddb.send(
        new PutItemCommand({
            TableName: CONNS_TABLE,
            Item: {
                userKey: { S: userKey },
                connectionId: { S: connectionId },
                ttl: { N: String(ttl) },
                connectedAt: { N: String(nowMs()) },
                userType: { S: userType },
                display: { S: display || "" },
                sub: { S: sub || "" },
                email: { S: email || "" },
            },
        })
    );
}

async function deleteConnection(userKey: string, connectionId: string) {
    await ddb.send(
        new DeleteItemCommand({
            TableName: CONNS_TABLE,
            Key: { userKey: { S: userKey }, connectionId: { S: connectionId } },
        })
    );
}

async function getConnections(userKey: string): Promise<string[]> {
    const out = await ddb.send(
        new QueryCommand({
            TableName: CONNS_TABLE,
            KeyConditionExpression: "userKey = :uk",
            ExpressionAttributeValues: { ":uk": { S: userKey } },
        })
    );
    const connections = out.Items?.map((i) => i.connectionId.S!) || [];
    return connections;
}

// ============== ROUTE HANDLERS ==============

async function onConnect(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> { 
    const claims = await validateToken(event);
    const userKey = userKeyFromClaims(claims);

    await putConnection(
        userKey,
        event.requestContext.connectionId,
        claims.userType,
        claims.name || claims.email || "",
        claims.sub || "",
        claims.email || ""
    );

    return { statusCode: 200, body: "Connected" };
}

async function onDisconnect(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const connectionId = event.requestContext.connectionId;

    const q = await ddb.send(
        new QueryCommand({
            TableName: CONNS_TABLE,
            IndexName: "connectionId-index",
            KeyConditionExpression: "connectionId = :cid",
            ExpressionAttributeValues: { ":cid": { S: connectionId } },
        })
    );

    if (!q.Items || q.Items.length === 0) {
        return { statusCode: 200, body: "Disconnected" };
    }

    // Delete all connection records associated with this connectionId
    await Promise.all(
        q.Items.map((item) =>
            ddb.send(
                new DeleteItemCommand({
                    TableName: CONNS_TABLE,
                    Key: { userKey: { S: item.userKey.S! }, connectionId: { S: connectionId } },
                })
            )
        )
    );

    return { statusCode: 200, body: "Disconnected" };
}


// ============== AVATAR / PROFILE IMAGE HELPERS ==============

// In-memory cache for presigned URLs with TTL (URLs expire after 1h, cache for 50min to be safe)
const AVATAR_CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes
const avatarCache = new Map<string, { url: string; cachedAt: number }>();

/**
 * Generates a presigned S3 GET URL for a given object key.
 * Returns empty string if the bucket is not configured or key is blank.
 */
async function presignS3Key(key: string): Promise<string> {
    if (!PROFILE_IMAGES_BUCKET || !key) return "";
    try {
        // Strip any leading bucket prefix or full URL — keep only the object key
        let objectKey = key;
        if (objectKey.startsWith("http")) {
            // e.g. https://s3.amazonaws.com/my-bucket/path/to/file.jpg
            const u = new URL(objectKey);
            const parts = u.pathname.split("/").filter(Boolean);
            // If first segment is the bucket name, skip it
            objectKey = parts[0] === PROFILE_IMAGES_BUCKET ? parts.slice(1).join("/") : parts.join("/");
        }
        if (!objectKey) return "";

        const cmd = new GetObjectCommand({ Bucket: PROFILE_IMAGES_BUCKET, Key: objectKey });
        return await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    } catch (e) {
        console.warn("presignS3Key failed", key, (e as Error).message);
        return "";
    }
}

/**
 * Looks up a professional's profile image key from DynamoDB and returns a presigned URL.
 * Result is cached for 50 minutes (presigned URLs expire after 60 min).
 */
async function getProfessionalAvatarUrl(profSub: string): Promise<string> {
    if (!profSub) return "";
    const cacheKey = `prof:${profSub}`;
    const cached = avatarCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < AVATAR_CACHE_TTL_MS) return cached.url;

    try {
        const res = await ddb.send(new GetItemCommand({
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: profSub } },
            ProjectionExpression: "profileImageKey",
        }));
        const imageKey = res.Item?.profileImageKey?.S || "";
        const url = imageKey ? await presignS3Key(imageKey) : "";
        avatarCache.set(cacheKey, { url, cachedAt: Date.now() });
        return url;
    } catch (e) {
        console.warn("getProfessionalAvatarUrl failed", profSub, (e as Error).message);
        avatarCache.set(cacheKey, { url: "", cachedAt: Date.now() });
        return "";
    }
}

/**
 * Looks up a clinic's office image from the clinic office images S3 bucket.
 * Lists objects under {clinicId}/clinic-office-image/ and presigns the latest one.
 */
async function getClinicAvatarUrl(clinicId: string): Promise<string> {
    if (!clinicId) return "";
    const cacheKey = `clinic:${clinicId}`;
    const cached = avatarCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < AVATAR_CACHE_TTL_MS) return cached.url;

    try {
        // First try: S3 clinic office images bucket
        if (CLINIC_OFFICE_IMAGES_BUCKET) {
            const prefix = `${clinicId}/clinic-office-image/`;
            const listRes = await s3.send(new ListObjectsV2Command({
                Bucket: CLINIC_OFFICE_IMAGES_BUCKET,
                Prefix: prefix,
            }));
            const files = (listRes.Contents || [])
                .filter(obj => obj.Key && !obj.Key.includes("/.meta/"))
                .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

            if (files.length > 0 && files[0].Key) {
                const url = await getSignedUrl(s3, new GetObjectCommand({
                    Bucket: CLINIC_OFFICE_IMAGES_BUCKET,
                    Key: files[0].Key,
                }), { expiresIn: 3600 });
                avatarCache.set(cacheKey, { url, cachedAt: Date.now() });
                return url;
            }
        }

        // Fallback: DynamoDB clinic profiles table (office_image_key)
        const res = await ddb.send(new QueryCommand({
            TableName: CLINIC_PROFILES_TABLE,
            KeyConditionExpression: "clinicId = :cid",
            ExpressionAttributeValues: { ":cid": { S: clinicId } },
            ProjectionExpression: "office_image_key",
            Limit: 1,
        }));
        const item = (res.Items || [])[0];
        const imageKey = item?.office_image_key?.S || "";
        const url = imageKey ? await presignS3Key(imageKey) : "";
        avatarCache.set(cacheKey, { url, cachedAt: Date.now() });
        return url;
    } catch (e) {
        console.warn("getClinicAvatarUrl failed", clinicId, (e as Error).message);
        avatarCache.set(cacheKey, { url: "", cachedAt: Date.now() });
        return "";
    }
}

async function onGetConversations(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const claims = await validateToken(event);
    const connClient = wsClientFromEvent(event);
    const connectionId = event.requestContext.connectionId;

    // Read optional clinicId from body for multi-clinic filtering
    let bodyClinicId: string | null = null;
    try {
        const body = JSON.parse(event.body || "{}");
        bodyClinicId = body.clinicId || null;
    } catch {
        // ignore parse errors
    }

    // Determine which key to query with
    let queryKey: string;
    if (claims.userType === "Clinic" && bodyClinicId && bodyClinicId !== "all") {
        queryKey = `clinic#${bodyClinicId}`;
    } else {
        queryKey = userKeyFromClaims(claims);
    }

    try {
        let items: Record<string, AttributeValue>[] = [];

        if (queryKey.startsWith("clinic#")) {
            const res = await ddb
                .send(
                    new QueryCommand({
                        TableName: CONVOS_TABLE,
                        IndexName: "clinicKey-lastMessageAt",
                        KeyConditionExpression: "clinicKey = :uk",
                        ExpressionAttributeValues: { ":uk": { S: queryKey } },
                        ScanIndexForward: false,
                    })
                )
                .catch(() => ({ Items: [] }));
            items = res.Items || [];

            if (!items.length) {
                const scan = await ddb
                    .send(
                        new ScanCommand({
                            TableName: CONVOS_TABLE,
                            FilterExpression: "clinicKey = :uk",
                            ExpressionAttributeValues: { ":uk": { S: queryKey } },
                        })
                    )
                    .catch(() => ({ Items: [] }));
                items = scan.Items || [];
            }
        } else if (queryKey.startsWith("prof#")) {
            const res = await ddb
                .send(
                    new QueryCommand({
                        TableName: CONVOS_TABLE,
                        IndexName: "profKey-lastMessageAt",
                        KeyConditionExpression: "profKey = :uk",
                        ExpressionAttributeValues: { ":uk": { S: queryKey } },
                        ScanIndexForward: false,
                    })
                )
                    .catch(() => ({ Items: [] }));
            items = res.Items || [];
        }

        const iAmClinic = claims.userType === "Clinic";

        // PHASE 1: Build conversations with names only (fast — no avatar lookups)
        const conversations = await Promise.all(
            items.map(async (it) => {
                const conversationId = it.conversationId?.S || "";
                const clinicKey = it.clinicKey?.S || "";
                const profKey = it.profKey?.S || "";
                const lastPreview = it.lastPreview?.S || "";
                const lastMessageAt = it.lastMessageAt?.N
                    ? new Date(Number(it.lastMessageAt.N)).toISOString()
                    : "";
                const clinicUnread = Number(it.clinicUnread?.N || 0);
                const profUnread = Number(it.profUnread?.N || 0);

                let recipientName = "";
                const otherKey = iAmClinic ? profKey : clinicKey;
                if (iAmClinic) {
                    const profSub = (profKey || "").replace(/^prof#/, "");
                    recipientName = await getCognitoNameBySub(profSub);
                } else {
                    recipientName = await getClinicDisplayByKey(clinicKey || "");
                }

                // Check if the other party is online (has active connections)
                let isOnline = false;
                try {
                    const conns = await getConnections(otherKey);
                    isOnline = conns.length > 0;
                } catch {}

                const unreadCount = iAmClinic ? clinicUnread : profUnread;

                return {
                    conversationId,
                    recipientName,
                    lastMessage: lastPreview,
                    lastMessageAt,
                    unreadCount,
                    isOnline,
                    clinicKey,
                    profKey,
                };
            })
        );

        conversations.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());

        // Send conversations immediately — user sees the list fast
        await send(connClient, connectionId, {
            type: "conversationsResponse",
            conversations: conversations.map(({ clinicKey, profKey, ...rest }) => rest),
        });

        // PHASE 2: Fetch avatars in background and send update
        try {
            const avatarMap: Record<string, string> = {};
            await Promise.all(
                conversations.map(async (c) => {
                    try {
                        let url = "";
                        if (iAmClinic) {
                            const profSub = (c.profKey || "").replace(/^prof#/, "");
                            url = await getProfessionalAvatarUrl(profSub);
                        } else {
                            const cid = (c.clinicKey || "").replace(/^clinic#/, "");
                            url = await getClinicAvatarUrl(cid);
                        }
                        if (url) avatarMap[c.conversationId] = url;
                    } catch { /* ignore */ }
                })
            );

            if (Object.keys(avatarMap).length > 0) {
                await send(connClient, connectionId, {
                    type: "avatarsUpdate",
                    avatars: avatarMap,
                });
            }
        } catch { /* avatar fetch is best-effort */ }

        return { statusCode: 200, body: "OK" };
    } catch (error) {
        console.error("Error fetching conversations:", {
            error: (error as Error).message,
            stack: (error as Error).stack,
        });
        await send(connClient, connectionId, {
            type: "error",
            error: "Failed to fetch conversations",
        });
        return { statusCode: 500, body: "Error" };
    }
}

async function onGetHistory(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> { 
    await validateToken(event);
    const body = JSON.parse(event.body || "{}");
    const { clinicId, professionalSub, limit: bodyLimit, nextKey } = body as { 
        clinicId: string, 
        professionalSub: string, 
        limit: string | number | undefined, 
        nextKey: any 
    };
    
    // Safety clamp the limit
    const limit = Math.max(1, Math.min(200, Number(bodyLimit) || 50)); 

    if (!clinicId || !professionalSub) {
        return { statusCode: 400, body: "Missing clinicId/professionalSub" };
    }
    const convoId = makeConversationId(clinicId, professionalSub);

    const params: QueryCommand["input"] = {
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: "conversationId = :cid",
        ExpressionAttributeValues: { ":cid": { S: convoId } },
        ScanIndexForward: false, // Newest messages first
        Limit: limit, 
    };
    if (nextKey) params.ExclusiveStartKey = nextKey as Record<string, AttributeValue>;

    const out = await ddb.send(new QueryCommand(params));

    const profName = await getCognitoNameBySub(professionalSub);
    // Note: getClinicDisplayByKey accepts 'clinic#<id>'
    const clinicName = await getClinicDisplayByKey(`clinic#${clinicId}`);

    const connClient = wsClientFromEvent(event);
    await send(connClient, event.requestContext.connectionId, {
        type: "history",
        conversationId: convoId,
        items: (out.Items || []).map((i) => { 
            const senderKey = i.senderKey.S!;
            const senderName = senderKey.startsWith("clinic#") ? clinicName : profName;
            return {
                messageId: i.messageId.S,
                timestamp: i.timestamp.S,
                senderKey,
                senderName, 
                content: i.content.S,
                messageType: i.type.S,
            };
        }),
        nextKey: out.LastEvaluatedKey || null,
    });

    return { statusCode: 200, body: "OK" };
}

async function onMarkRead(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const claims = await validateToken(event);
        const senderKey = userKeyFromClaims(claims);
        const body = JSON.parse(event.body || "{}");
        const { clinicId, professionalSub } = body;

        if (!clinicId || !professionalSub) {
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Missing clinicId or professionalSub",
            });
            return { statusCode: 400, body: "Missing clinicId or professionalSub" };
        }

        const expectedSenderKey =
            claims.userType === "Clinic" ? `clinic#${claims.clinicId}` : `prof#${claims.sub}`;
        
        // Authorization check: User must be one of the two parties in the conversation
        const isUserAuthorized = 
            (claims.userType === "Clinic" && claims.clinicId === clinicId) ||
            (claims.userType === "Professional" && claims.sub === professionalSub);

        if (!isUserAuthorized) {
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Sender not authorized for this conversation",
            });
            return { statusCode: 403, body: "Sender not authorized" };
        }

        const conversationId = makeConversationId(clinicId, professionalSub);
        const isSenderClinic = claims.userType === "Clinic";
        const unreadAttribute = isSenderClinic ? "clinicUnread" : "profUnread";

        // Set the unread count for the sender's side to 0
        await ddb.send(
            new UpdateItemCommand({
                TableName: CONVOS_TABLE,
                Key: { conversationId: { S: conversationId } },
                UpdateExpression: `SET #unread = :zero`,
                ExpressionAttributeNames: { "#unread": unreadAttribute },
                ExpressionAttributeValues: { ":zero": { N: "0" } },
            })
        );

        const connClient = wsClientFromEvent(event);
        await send(connClient, event.requestContext.connectionId, {
            type: "ack",
            conversationId,
            action: "markRead",
        });

        // Notify the OTHER party that their messages have been read
        const otherKey = isSenderClinic ? `prof#${professionalSub}` : `clinic#${clinicId}`;
        try {
            const otherConns = await getConnections(otherKey);
            await Promise.all(
                otherConns.map(async (cid) => {
                    try {
                        await send(connClient, cid, {
                            type: "readReceipt",
                            conversationId,
                            readBy: senderKey,
                        });
                    } catch {}
                })
            );
        } catch {}

        return { statusCode: 200, body: "Messages marked as read" };
    } catch (error) {
        console.error("Error marking messages as read:", {
            error: (error as Error).message,
            stack: (error as Error).stack,
        });
        const connClient = wsClientFromEvent(event);
        await send(connClient, event.requestContext.connectionId, {
            type: "error",
            error: "Failed to mark messages as read",
        });
        return { statusCode: 500, body: "Error" };
    }
}

async function onSendMessage(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        const claims = await validateToken(event);
        const senderKey = userKeyFromClaims(claims);
        const body = JSON.parse(event.body || "{}");
        const { clinicId, professionalSub, content, messageType = "text" } = body;

        if (!clinicId || !professionalSub || !content || content.length > MAX_LEN) {
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Missing or invalid clinicId, professionalSub, or content (max 1000 chars)",
            });
            return { statusCode: 400, body: "Missing or invalid data" };
        }

        // Authorization check: User must be one of the two parties in the conversation
        const isUserAuthorized = 
            (claims.userType === "Clinic" && claims.clinicId === clinicId) ||
            (claims.userType === "Professional" && claims.sub === professionalSub);

        if (!isUserAuthorized) {
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Sender not authorized for this conversation",
            });
            return { statusCode: 403, body: "Sender not authorized" };
        }

        const conversationId = makeConversationId(clinicId, professionalSub);

        // Store message
        const messageId = `${nowMs()}-${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = isoNow();
        await ddb.send(
            new PutItemCommand({
                TableName: MESSAGES_TABLE,
                Item: {
                    conversationId: { S: conversationId },
                    messageId: { S: messageId }, // This is the Sort Key now
                    senderKey: { S: senderKey },
                    content: { S: content },
                    timestamp: { S: timestamp }, // Storing ISO timestamp for display/sorting clarity
                    type: { S: messageType },
                },
            })
        );

        // Resolve names for updates/notifications
        const isSenderClinic = claims.userType === "Clinic";
        const profName = await getCognitoNameBySub(professionalSub);
        // Use the authenticated user's name if available, otherwise fetch clinic display
        const clinicName =
            (claims.userType === "Clinic" ? claims.name : undefined) || 
            (await getClinicDisplayByKey(`clinic#${clinicId}`));
            
        const senderName = isSenderClinic ? clinicName : profName;

        // Update conversation aggregates 
        // 1. Increment recipient's unread count.
        // 2. Reset sender's unread count to 0 (since they just sent a message).
        const unreadAttribute = isSenderClinic ? "profUnread" : "clinicUnread";
        const otherUnreadAttribute = isSenderClinic ? "clinicUnread" : "profUnread";
        await ddb.send(
            new UpdateItemCommand({
                TableName: CONVOS_TABLE,
                Key: { conversationId: { S: conversationId } },
                UpdateExpression:
                    `SET clinicKey = :ck, profKey = :pk, ` +
                    `clinicName = :cname, profName = :pname, ` +
                    `lastMessageAt = :lma, lastPreview = :lp, ` +
                    `#unread = if_not_exists(#unread, :zero) + :inc, #otherUnread = :zero`,
                ExpressionAttributeNames: {
                    "#unread": unreadAttribute, // Recipient's unread
                    "#otherUnread": otherUnreadAttribute, // Sender's unread
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
                },
            })
        );

        // Notify recipient AND sender's other connections (multi-tab support)
        const recipientKey = isSenderClinic ? `prof#${professionalSub}` : `clinic#${clinicId}`;
        const senderConnKey = isSenderClinic ? `clinic#${clinicId}` : `prof#${professionalSub}`;
        const currentConnectionId = event.requestContext.connectionId;

        const [recipientConnections, senderConnections] = await Promise.all([
            getConnections(recipientKey),
            getConnections(senderConnKey),
        ]);

        const connClient = wsClientFromEvent(event);

        // Structure the payload
        const flat = {
            type: "message",
            conversationId,
            messageId,
            senderKey,
            senderName,
            content,
            timestamp,
            messageType,
            clinicId,
            professionalSub,
        };
        const payload = { ...flat, message: flat };

        // Push to all recipient connections
        let delivered = false;
        await Promise.all(
            recipientConnections.map(async (connectionId) => {
                try {
                    await send(connClient, connectionId, payload);
                    delivered = true;
                } catch (err) {
                    console.error("Failed to notify recipient:", {
                        connectionId,
                        error: (err as Error).message,
                    });
                }
            })
        );

        // Push to sender's OTHER connections (not the current one — that gets an ack)
        const otherSenderConns = senderConnections.filter(cid => cid !== currentConnectionId);
        if (otherSenderConns.length) {
            await Promise.all(
                otherSenderConns.map(async (connectionId) => {
                    try {
                        await send(connClient, connectionId, payload);
                    } catch (err) {
                        console.error("Failed to notify sender's other connection:", {
                            connectionId,
                            error: (err as Error).message,
                        });
                    }
                })
            );
        }

        // Sender ack with delivery status
        await send(connClient, currentConnectionId, {
            type: "ack",
            messageId,
            conversationId,
            timestamp,
            status: delivered ? "delivered" : "sent",
        });

        return { statusCode: 200, body: "Message sent" };
    } catch (error) {
        console.error("Error sending message:", { error: (error as Error).message, stack: (error as Error).stack });
        const connClient = wsClientFromEvent(event);
        await send(connClient, event.requestContext.connectionId, {
            type: "error",
            error: "Failed to send message",
        });
        return { statusCode: 500, body: "Error" };
    }
}

async function onDefault(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const connClient = wsClientFromEvent(event);
    await send(connClient, event.requestContext.connectionId, {
        type: "error",
        error:
            "Unknown or missing action. Expected one of: sendMessage, getHistory, markRead, getConversations.",
    });
    return { statusCode: 200, body: "Unknown action" };
}

// ============== MAIN HANDLER ==============
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => { 
    // Assert the event shape to include connectionId, as it must be present for WebSocket invocations
    const wsEvent = event as WebSocketAPIGatewayEventV2;

    try {
        const route = wsEvent.requestContext.routeKey;
        let action = route;
        
        // Handle custom routes sent through the $default route by checking the body 'action' field
        if (route === "$default" && wsEvent.body) {
            try {
                const body = JSON.parse(wsEvent.body) as { action?: string }; 
                action = body.action || route;
            } catch (e) {
                console.warn("Could not parse body for action:", (e as Error).message);
            }
        }

        if (action === "$connect") return await onConnect(wsEvent);
        if (action === "$disconnect") return await onDisconnect(wsEvent);

        if (action === "sendMessage") return await onSendMessage(wsEvent);
        if (action === "getHistory") return await onGetHistory(wsEvent);
        if (action === "markRead") return await onMarkRead(wsEvent);
        if (action === "getConversations") return await onGetConversations(wsEvent);

        return await onDefault(wsEvent);
    } catch (err) {
        console.error("WebSocket handler error:", { error: (err as Error).message, stack: (err as Error).stack });
        try {
            const connClient = wsClientFromEvent(wsEvent);
            await send(connClient, wsEvent.requestContext.connectionId, {
                type: "error",
                error: (err as Error)?.message || "Internal error",
            });
        } catch (sendErr) {
            console.error("Failed to send error response:", { error: (sendErr as Error).message });
        }
        return { statusCode: 500, body: "Error" };
    }
};