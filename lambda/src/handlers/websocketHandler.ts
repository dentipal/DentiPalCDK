import {
    DynamoDBClient,
    PutItemCommand,
    UpdateItemCommand,
    QueryCommand,
    DeleteItemCommand,
    GetItemCommand,
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

import { CognitoJwtVerifier } from "aws-jwt-verify";

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
const CLIENT_ID = process.env.CLIENT_ID || "";
const USER_CLINIC_ASSIGNMENTS_TABLE = process.env.USER_CLINIC_ASSIGNMENTS_TABLE || "DentiPal-V5-UserClinicAssignments";
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-V5-ProfessionalProfiles";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-V5-Clinic-Profiles";
const PROFILE_IMAGES_BUCKET = process.env.PROFILE_IMAGES_BUCKET || "";
const CLINIC_OFFICE_IMAGES_BUCKET = process.env.CLINIC_OFFICE_IMAGES_BUCKET || "";

const ddb = new DynamoDBClient({ region: REGION });
const cognitoIdp = new CognitoIdentityProviderClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const MAX_LEN = 1000;

// Pagination defaults (applied everywhere — no more unbounded reads)
const DEFAULT_CONVO_PAGE = 50;
const MAX_CONVO_PAGE = 100;
const DEFAULT_HISTORY_PAGE = 50;
const MAX_HISTORY_PAGE = 200;

// Cognito lookup concurrency when hydrating conversation rows
const COGNITO_CONCURRENCY = 10;

// Cognito JWT verifier (signature + exp + iss + token_use). Shared, reused across invocations.
// Note: clientId=null accepts any app client in this user pool. If you later want to pin
// to a single app client, pass CLIENT_ID instead.
const accessVerifier = CognitoJwtVerifier.create({
    userPoolId: USER_POOL_ID,
    tokenUse: "access",
    clientId: CLIENT_ID || null,
});

// Bounded LRU-ish name cache (warm Lambda only).
// Entries expire after NAME_CACHE_TTL_MS and we trim to MAX_NAME_CACHE_ENTRIES.
const NAME_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_NAME_CACHE_ENTRIES = 500;
const nameCache = new Map<string, { value: string; cachedAt: number }>();

function getNameFromCache(key: string): string | undefined {
    const hit = nameCache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.cachedAt > NAME_CACHE_TTL_MS) {
        nameCache.delete(key);
        return undefined;
    }
    // LRU bump
    nameCache.delete(key);
    nameCache.set(key, hit);
    return hit.value;
}

function setNameInCache(key: string, value: string): void {
    if (nameCache.has(key)) nameCache.delete(key);
    nameCache.set(key, { value, cachedAt: Date.now() });
    while (nameCache.size > MAX_NAME_CACHE_ENTRIES) {
        const firstKey = nameCache.keys().next().value as string | undefined;
        if (!firstKey) break;
        nameCache.delete(firstKey);
    }
}

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
                        Limit: 5,
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

// Get human name for a professional from Cognito (cached with TTL + LRU)
async function getCognitoNameBySub(sub: string): Promise<string> {
    const cacheKey = `prof#${sub}`;
    const cached = getNameFromCache(cacheKey);
    if (cached !== undefined) return cached;

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

        setNameInCache(cacheKey, display);
        return display;
    } catch (e) {
        console.error("getCognitoNameBySub failed", { sub, error: (e as Error).message });
        const fallback = `User ${String(sub).slice(0, 6)}`;
        setNameInCache(cacheKey, fallback);
        return fallback;
    }
}

// ── Multi-clinic access check ──
// A single Cognito user can belong to multiple clinics (tracked in the
// UserClinicAssignments table). The `claims.clinicId` on the connection is
// only the clinic they opened the socket with — for "All Clinics" views the
// client fans out one getConversations per assigned clinic, and every one of
// those requests needs to be authorized against the assignments table.
const ACCESS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const accessCache = new Map<string, { allowed: boolean; cachedAt: number }>();

async function hasClinicAccess(userSub: string, clinicId: string): Promise<boolean> {
    if (!userSub || !clinicId) {
        console.warn("[authz] hasClinicAccess called with empty sub/clinic", { userSub, clinicId });
        return false;
    }
    const cacheKey = `${userSub}|${clinicId}`;
    const cached = accessCache.get(cacheKey);
    if (cached && (Date.now() - cached.cachedAt) < ACCESS_CACHE_TTL_MS) {
        return cached.allowed;
    }

    // Two sources of truth exist for clinic membership in this codebase:
    //  1. DentiPal-V5-Clinics.AssociatedUsers  (set[userSub])  — used by getAllClinics
    //  2. DentiPal-V5-UserClinicAssignments    (userSub, clinicId) — used by utils.hasClinicAccess
    // They can disagree (legacy: #1 existed first, #2 was added later and isn't
    // always backfilled). Treat EITHER as proof of membership so the inbox
    // respects the clinic list the user actually sees in the UI.
    let allowed = false;
    try {
        const clinicRow = await ddb.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            ProjectionExpression: "AssociatedUsers, createdBy",
        }));
        const associated = clinicRow.Item?.AssociatedUsers;
        const createdBy = clinicRow.Item?.createdBy?.S;
        // AssociatedUsers can be stored as StringSet (SS) or List-of-strings (L)
        if (associated?.SS?.includes(userSub)) allowed = true;
        else if (associated?.L?.some((x) => x.S === userSub)) allowed = true;
        else if (createdBy === userSub) allowed = true; // Root/creator case
    } catch (e) {
        console.warn("[authz] Clinics.AssociatedUsers lookup failed", {
            userSub,
            clinicId,
            error: (e as Error).message,
        });
    }

    if (!allowed) {
        // Fall back to the assignments table for completeness
        try {
            const out = await ddb.send(new GetItemCommand({
                TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
                Key: { userSub: { S: userSub }, clinicId: { S: clinicId } },
                ProjectionExpression: "userSub",
            }));
            if (out.Item) allowed = true;
        } catch (e) {
            console.error("[authz] UserClinicAssignments lookup failed", {
                userSub,
                clinicId,
                error: (e as Error).message,
            });
        }
    }

    console.log("[authz] hasClinicAccess", { userSub, clinicId, allowed });
    accessCache.set(cacheKey, { allowed, cachedAt: Date.now() });
    return allowed;
}

// Resolve a batch of professional sub → display name with bounded concurrency.
// Replaces the sequential await-per-row pattern in onGetConversations.
async function getCognitoNamesBySubs(subs: string[]): Promise<Record<string, string>> {
    const unique = Array.from(new Set(subs.filter(Boolean)));
    const out: Record<string, string> = {};

    for (let i = 0; i < unique.length; i += COGNITO_CONCURRENCY) {
        const chunk = unique.slice(i, i + COGNITO_CONCURRENCY);
        const results = await Promise.all(chunk.map((s) => getCognitoNameBySub(s)));
        chunk.forEach((sub, idx) => { out[sub] = results[idx]; });
    }
    return out;
}

// Try to grab a human display for a clinic — Clinics table first, then active connections
async function getClinicDisplayByKey(clinicKey: string): Promise<string> {
    if (!clinicKey) return "";
    const cached = getNameFromCache(clinicKey);
    if (cached !== undefined) return cached;

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
            setNameInCache(clinicKey, name.trim());
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
                Limit: 5,
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
                setNameInCache(clinicKey, display);
                return display;
            }
        }
    } catch (e) {
        console.warn("Connections lookup failed for", clinicKey, (e as Error).message);
    }

    // 3. Last resort fallback
    const fallback = `Clinic ${clinicId.slice(0, 6)}`;
    setNameInCache(clinicKey, fallback);
    return fallback;
}

// ============== ACCESS TOKEN VERIFICATION ==============

/**
 * Verifies the Cognito access-token signature, expiration, issuer, and token_use.
 * Replaces the previous base64-only decode that accepted any forged/expired JWT.
 * @throws Error if verification fails for any reason.
 */
async function verifyAccessToken(token: string): Promise<Record<string, any>> {
    if (!token || token.split(".").length !== 3) {
        throw new Error("Invalid access token format (expected 3 JWT parts)");
    }
    try {
        // aws-jwt-verify fetches the JWKS once, caches it, and checks signature + exp + iss + token_use
        const payload = await accessVerifier.verify(token);
        return payload as unknown as Record<string, any>;
    } catch (err) {
        throw new Error(`Access token verification failed: ${(err as Error).message}`);
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

    // Defence-in-depth: aws-jwt-verify already enforces token_use === "access"
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
            Limit: 5,
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

        // --- Access Token Verification (signature + exp + iss + token_use) ---
        const claims = await (async () => {
            try {
                const payload = await verifyAccessToken(token);
                return extractUserInfoFromAccessTokenClaims(payload);
            } catch (err) {
                console.error("Access Token verification failed:", {
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
            // Optional re-verification using token in body (full signature + exp check)
            const tokenClaims = await (async () => {
                try {
                    const payload = await verifyAccessToken(bodyToken);
                    return extractUserInfoFromAccessTokenClaims(payload);
                } catch (err) {
                    console.error("Access Token verification failed in body:", {
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
            Limit: 20,
        })
    );
    const connections = out.Items?.map((i) => i.connectionId.S!) || [];
    return connections;
}

// ============== ROUTE HANDLERS ==============

async function onConnect(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const started = Date.now();
    const connectionId = event.requestContext.connectionId;
    console.log("[ws] $connect START", { connectionId });

    const claims = await validateToken(event);
    const userKey = userKeyFromClaims(claims);

    await putConnection(
        userKey,
        connectionId,
        claims.userType,
        claims.name || claims.email || "",
        claims.sub || "",
        claims.email || ""
    );

    console.log("[ws] $connect OK", {
        connectionId,
        userKey,
        userType: claims.userType,
        sub: claims.sub,
        clinicId: claims.clinicId,
        isRoot: claims.isRoot === true,
        email: claims.email,
        elapsedMs: Date.now() - started,
    });

    return { statusCode: 200, body: "Connected" };
}

async function onDisconnect(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const started = Date.now();
    const connectionId = event.requestContext.connectionId;
    console.log("[ws] $disconnect START", { connectionId });

    const q = await ddb.send(
        new QueryCommand({
            TableName: CONNS_TABLE,
            IndexName: "connectionId-index",
            KeyConditionExpression: "connectionId = :cid",
            ExpressionAttributeValues: { ":cid": { S: connectionId } },
            Limit: 5,
        })
    );

    if (!q.Items || q.Items.length === 0) {
        console.log("[ws] $disconnect OK (no rows)", { connectionId, elapsedMs: Date.now() - started });
        return { statusCode: 200, body: "Disconnected" };
    }

    const userKeys = q.Items.map((i) => i.userKey?.S).filter((v): v is string => !!v);

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

    console.log("[ws] $disconnect OK", {
        connectionId,
        userKeys,
        deleted: q.Items.length,
        elapsedMs: Date.now() - started,
    });

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
    const started = Date.now();
    const claims = await validateToken(event);
    const connClient = wsClientFromEvent(event);
    const connectionId = event.requestContext.connectionId;

    // Read optional body params: clinicId (for multi-clinic clinic users), pagination
    let bodyClinicId: string | null = null;
    let bodyLimit: unknown = undefined;
    let bodyNextKey: Record<string, AttributeValue> | undefined;
    try {
        const body = JSON.parse(event.body || "{}");
        bodyClinicId = body.clinicId || null;
        bodyLimit = body.limit;
        bodyNextKey = body.nextKey || undefined;
    } catch {
        console.warn("[ws] getConversations body parse failed", { body: event.body });
    }

    const limit = Math.max(1, Math.min(MAX_CONVO_PAGE, Number(bodyLimit) || DEFAULT_CONVO_PAGE));

    console.log("[ws] getConversations START", {
        connectionId,
        userType: claims.userType,
        sub: claims.sub,
        connectionClinicId: claims.clinicId,
        bodyClinicId,
        limit,
        hasNextKey: !!bodyNextKey,
    });

    // --- Authorization: clinic users filtering by clinicId must have an assignment to that clinic ---
    // A user may belong to several clinics (see the "All Clinics" view which fans
    // out one getConversations per clinic), so we verify access against the
    // UserClinicAssignments table rather than only against claims.clinicId.
    if (claims.userType === "Clinic" && bodyClinicId && bodyClinicId !== "all") {
        const allowed =
            claims.isRoot === true ||
            claims.clinicId === bodyClinicId || // fast path: the clinic they connected as
            (!!claims.sub && await hasClinicAccess(claims.sub, bodyClinicId));
        if (!allowed) {
            console.warn("[authz] onGetConversations REJECTED", {
                reason: "no UserClinicAssignments row + not connection clinic + not root",
                userType: claims.userType,
                sub: claims.sub,
                connectionClinicId: claims.clinicId,
                bodyClinicId,
                isRoot: claims.isRoot,
            });
            await send(connClient, connectionId, {
                type: "error",
                error: "Not authorized to view this clinic's conversations",
            });
            return { statusCode: 403, body: "Forbidden" };
        }
    }

    // Determine which GSI key to query with
    let queryKey: string;
    if (claims.userType === "Clinic" && bodyClinicId && bodyClinicId !== "all") {
        queryKey = `clinic#${bodyClinicId}`;
    } else {
        queryKey = userKeyFromClaims(claims);
    }

    try {
        let items: Record<string, AttributeValue>[] = [];
        let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

        const queryStarted = Date.now();
        if (queryKey.startsWith("clinic#")) {
            const res = await ddb.send(
                new QueryCommand({
                    TableName: CONVOS_TABLE,
                    IndexName: "clinicKey-lastMessageAt",
                    KeyConditionExpression: "clinicKey = :uk",
                    ExpressionAttributeValues: { ":uk": { S: queryKey } },
                    ScanIndexForward: false,
                    Limit: limit,
                    ExclusiveStartKey: bodyNextKey,
                })
            );
            items = res.Items || [];
            lastEvaluatedKey = res.LastEvaluatedKey;
        } else if (queryKey.startsWith("prof#")) {
            const res = await ddb.send(
                new QueryCommand({
                    TableName: CONVOS_TABLE,
                    IndexName: "profKey-lastMessageAt",
                    KeyConditionExpression: "profKey = :uk",
                    ExpressionAttributeValues: { ":uk": { S: queryKey } },
                    ScanIndexForward: false,
                    Limit: limit,
                    ExclusiveStartKey: bodyNextKey,
                })
            );
            items = res.Items || [];
            lastEvaluatedKey = res.LastEvaluatedKey;
        }
        console.log("[ws] getConversations DDB Query done", {
            queryKey,
            items: items.length,
            hasMore: !!lastEvaluatedKey,
            queryMs: Date.now() - queryStarted,
        });

        const iAmClinic = claims.userType === "Clinic";

        // Pre-batch the Cognito name lookups so we don't serialize them per row
        let profNameMap: Record<string, string> = {};
        if (iAmClinic) {
            const profSubs = items
                .map((it) => (it.profKey?.S || "").replace(/^prof#/, ""))
                .filter(Boolean);
            profNameMap = await getCognitoNamesBySubs(profSubs);
        }

        // PHASE 1: Build conversation rows (names only — avatars come in Phase 2)
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
                    recipientName = profNameMap[profSub] || await getCognitoNameBySub(profSub);
                } else {
                    recipientName = await getClinicDisplayByKey(clinicKey || "");
                }

                // Check if the other party is online (has active connections)
                let isOnline = false;
                try {
                    const conns = await getConnections(otherKey);
                    isOnline = conns.length > 0;
                } catch (e) {
                    console.warn("isOnline lookup failed", otherKey, (e as Error).message);
                }

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
            nextKey: lastEvaluatedKey || null,
            hasMore: !!lastEvaluatedKey,
        });
        console.log("[ws] getConversations conversationsResponse sent", {
            connectionId,
            count: conversations.length,
            hasMore: !!lastEvaluatedKey,
            phase1Ms: Date.now() - started,
        });

        // PHASE 2: Fetch avatars in background and send update
        const avatarStarted = Date.now();
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
                    } catch (e) {
                        console.warn("[ws] avatar lookup failed for", c.conversationId, (e as Error).message);
                    }
                })
            );

            if (Object.keys(avatarMap).length > 0) {
                await send(connClient, connectionId, {
                    type: "avatarsUpdate",
                    avatars: avatarMap,
                });
                console.log("[ws] getConversations avatarsUpdate sent", {
                    connectionId,
                    avatars: Object.keys(avatarMap).length,
                    avatarMs: Date.now() - avatarStarted,
                });
            } else {
                console.log("[ws] getConversations no avatars resolved", {
                    connectionId,
                    avatarMs: Date.now() - avatarStarted,
                });
            }
        } catch (e) {
            console.warn("[ws] avatar phase errored", (e as Error).message);
        }

        console.log("[ws] getConversations DONE", {
            connectionId,
            totalMs: Date.now() - started,
        });
        return { statusCode: 200, body: "OK" };
    } catch (error) {
        console.error("[ws] getConversations FAILED", {
            connectionId,
            error: (error as Error).message,
            stack: (error as Error).stack,
            elapsedMs: Date.now() - started,
        });
        await send(connClient, connectionId, {
            type: "error",
            error: "Failed to fetch conversations",
        });
        return { statusCode: 500, body: "Error" };
    }
}

async function onGetHistory(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const started = Date.now();
    const connectionId = event.requestContext.connectionId;
    const claims = await validateToken(event);
    const body = JSON.parse(event.body || "{}");
    const { clinicId, professionalSub, limit: bodyLimit, nextKey } = body as {
        clinicId: string,
        professionalSub: string,
        limit: string | number | undefined,
        nextKey: any
    };

    // Safety clamp the limit to the paginated default/max
    const limit = Math.max(1, Math.min(MAX_HISTORY_PAGE, Number(bodyLimit) || DEFAULT_HISTORY_PAGE));

    console.log("[ws] getHistory START", {
        connectionId,
        userType: claims.userType,
        sub: claims.sub,
        connectionClinicId: claims.clinicId,
        bodyClinicId: clinicId,
        bodyProfessionalSub: professionalSub,
        limit,
        hasNextKey: !!nextKey,
    });

    if (!clinicId || !professionalSub) {
        console.warn("[ws] getHistory 400 missing params", { clinicId, professionalSub });
        return { statusCode: 400, body: "Missing clinicId/professionalSub" };
    }

    // --- Authorization: caller must be one of the two parties in this conversation ---
    // Previously onGetHistory had NO auth check. Clinic users can belong to many
    // clinics, so we verify via UserClinicAssignments when the body clinicId
    // doesn't match the connection clinicId.
    const clinicOk =
        claims.userType === "Clinic" &&
        !!claims.sub &&
        (claims.isRoot === true ||
            claims.clinicId === clinicId ||
            await hasClinicAccess(claims.sub, clinicId));
    const profOk = claims.userType === "Professional" && !!claims.sub && claims.sub === professionalSub;
    const isAuthorized = claims.isRoot === true || clinicOk || profOk;

    if (!isAuthorized) {
        console.warn("[authz] onGetHistory REJECTED", {
            userType: claims.userType,
            sub: claims.sub,
            connectionClinicId: claims.clinicId,
            bodyClinicId: clinicId,
            bodyProfessionalSub: professionalSub,
            isRoot: claims.isRoot,
        });
        const connClient = wsClientFromEvent(event);
        await send(connClient, event.requestContext.connectionId, {
            type: "error",
            error: "Not authorized to view this conversation's history",
        });
        return { statusCode: 403, body: "Forbidden" };
    }

    const convoId = makeConversationId(clinicId, professionalSub);

    // Fetch messages and conversation record in parallel
    const msgParams: QueryCommand["input"] = {
        TableName: MESSAGES_TABLE,
        KeyConditionExpression: "conversationId = :cid",
        ExpressionAttributeValues: { ":cid": { S: convoId } },
        ScanIndexForward: false, // Newest messages first
        Limit: limit,
    };
    if (nextKey) msgParams.ExclusiveStartKey = nextKey as Record<string, AttributeValue>;

    const [out, convoRes, profName, clinicName] = await Promise.all([
        ddb.send(new QueryCommand(msgParams)),
        ddb.send(new GetItemCommand({
            TableName: CONVOS_TABLE,
            Key: { conversationId: { S: convoId } },
            ProjectionExpression: "clinicUnread, profUnread",
        })),
        getCognitoNameBySub(professionalSub),
        getClinicDisplayByKey(`clinic#${clinicId}`),
    ]);

    // Determine unread counts for the OTHER side to figure out read status of my messages
    const clinicUnread = Number(convoRes.Item?.clinicUnread?.N || 0);
    const profUnread = Number(convoRes.Item?.profUnread?.N || 0);
    const iAmClinic = claims.userType === "Clinic";
    // If the other side has 0 unread, all my messages are "read"
    const otherUnread = iAmClinic ? profUnread : clinicUnread;
    const myKey = iAmClinic ? `clinic#${clinicId}` : `prof#${professionalSub}`;

    const connClient = wsClientFromEvent(event);
    await send(connClient, event.requestContext.connectionId, {
        type: "history",
        conversationId: convoId,
        items: (out.Items || []).map((i) => {
            const senderKey = i.senderKey.S!;
            const senderName = senderKey.startsWith("clinic#") ? clinicName : profName;
            const isMine = senderKey === myKey;
            // My messages: "read" if other side has 0 unread, otherwise "delivered"
            // Their messages: no status needed (frontend only shows ticks on mine)
            const status = isMine ? (otherUnread === 0 ? "read" : "delivered") : undefined;
            return {
                messageId: i.messageId.S,
                timestamp: i.timestamp.S,
                senderKey,
                senderName,
                content: i.content.S,
                messageType: i.type.S,
                ...(status ? { status } : {}),
            };
        }),
        nextKey: out.LastEvaluatedKey || null,
    });

    console.log("[ws] getHistory DONE", {
        connectionId,
        conversationId: convoId,
        items: (out.Items || []).length,
        hasMore: !!out.LastEvaluatedKey,
        totalMs: Date.now() - started,
    });
    return { statusCode: 200, body: "OK" };
}

async function onMarkRead(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    const started = Date.now();
    const connectionId = event.requestContext.connectionId;
    try {
        const claims = await validateToken(event);
        const senderKey = userKeyFromClaims(claims);
        const body = JSON.parse(event.body || "{}");
        const { clinicId, professionalSub } = body;

        console.log("[ws] markRead START", {
            connectionId,
            senderKey,
            userType: claims.userType,
            sub: claims.sub,
            bodyClinicId: clinicId,
            bodyProfessionalSub: professionalSub,
        });

        if (!clinicId || !professionalSub) {
            console.warn("[ws] markRead 400 missing params", { clinicId, professionalSub });
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Missing clinicId or professionalSub",
            });
            return { statusCode: 400, body: "Missing clinicId or professionalSub" };
        }

        // Authorization check: caller must be one of the two parties.
        // For clinic users, the clinicId is checked against UserClinicAssignments
        // so multi-clinic users can markRead on any of their assigned clinics.
        const clinicOk =
            claims.userType === "Clinic" && !!claims.sub &&
            (claims.isRoot === true ||
                claims.clinicId === clinicId ||
                await hasClinicAccess(claims.sub, clinicId));
        const profOk = claims.userType === "Professional" && !!claims.sub && claims.sub === professionalSub;
        const isUserAuthorized = claims.isRoot === true || clinicOk || profOk;

        if (!isUserAuthorized) {
            console.warn("[authz] onMarkRead REJECTED", {
                userType: claims.userType,
                sub: claims.sub,
                connectionClinicId: claims.clinicId,
                bodyClinicId: clinicId,
                bodyProfessionalSub: professionalSub,
                isRoot: claims.isRoot,
            });
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
        let receiptsSent = 0;
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
                        receiptsSent++;
                    } catch (err) {
                        console.warn("[ws] markRead readReceipt send failed", { cid, error: (err as Error).message });
                    }
                })
            );
        } catch (err) {
            console.warn("[ws] markRead fan-out lookup failed", { otherKey, error: (err as Error).message });
        }

        console.log("[ws] markRead DONE", {
            connectionId,
            conversationId,
            senderKey,
            otherKey,
            readReceiptsDelivered: receiptsSent,
            totalMs: Date.now() - started,
        });
        return { statusCode: 200, body: "Messages marked as read" };
    } catch (error) {
        console.error("[ws] markRead FAILED", {
            connectionId,
            error: (error as Error).message,
            stack: (error as Error).stack,
            elapsedMs: Date.now() - started,
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
    const started = Date.now();
    const connectionId = event.requestContext.connectionId;
    try {
        const claims = await validateToken(event);
        const senderKey = userKeyFromClaims(claims);
        const body = JSON.parse(event.body || "{}");
        const { clinicId, professionalSub, content, messageType = "text" } = body;

        console.log("[ws] sendMessage START", {
            connectionId,
            senderKey,
            userType: claims.userType,
            sub: claims.sub,
            bodyClinicId: clinicId,
            bodyProfessionalSub: professionalSub,
            messageType,
            contentLen: typeof content === "string" ? content.length : 0,
        });

        if (!clinicId || !professionalSub || !content || content.length > MAX_LEN) {
            console.warn("[ws] sendMessage 400 invalid payload", {
                hasClinicId: !!clinicId,
                hasProfSub: !!professionalSub,
                contentLen: typeof content === "string" ? content.length : 0,
            });
            const connClient = wsClientFromEvent(event);
            await send(connClient, event.requestContext.connectionId, {
                type: "error",
                error: "Missing or invalid clinicId, professionalSub, or content (max 1000 chars)",
            });
            return { statusCode: 400, body: "Missing or invalid data" };
        }

        // Authorization check: caller must be one of the two parties in the conversation.
        // Multi-clinic users are allowed if they have an assignment to the clinic.
        // (Root cannot send on behalf of someone else — that would need an explicit senderKey contract.)
        const clinicOk =
            claims.userType === "Clinic" && !!claims.sub &&
            (claims.clinicId === clinicId || await hasClinicAccess(claims.sub, clinicId));
        const profOk = claims.userType === "Professional" && !!claims.sub && claims.sub === professionalSub;
        const isUserAuthorized = clinicOk || profOk;

        if (!isUserAuthorized) {
            console.warn("[authz] onSendMessage REJECTED", {
                userType: claims.userType,
                sub: claims.sub,
                connectionClinicId: claims.clinicId,
                bodyClinicId: clinicId,
                bodyProfessionalSub: professionalSub,
                isRoot: claims.isRoot,
            });
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

        console.log("[ws] sendMessage DONE", {
            connectionId,
            conversationId,
            messageId,
            senderKey,
            recipientKey,
            recipientConns: recipientConnections.length,
            senderOtherConns: otherSenderConns.length,
            delivered,
            totalMs: Date.now() - started,
        });
        return { statusCode: 200, body: "Message sent" };
    } catch (error) {
        console.error("[ws] sendMessage FAILED", {
            connectionId,
            error: (error as Error).message,
            stack: (error as Error).stack,
            elapsedMs: Date.now() - started,
        });
        const connClient = wsClientFromEvent(event);
        await send(connClient, event.requestContext.connectionId, {
            type: "error",
            error: "Failed to send message",
        });
        return { statusCode: 500, body: "Error" };
    }
}

async function onDefault(event: WebSocketAPIGatewayEventV2): Promise<APIGatewayProxyResultV2> {
    console.warn("[ws] onDefault (unknown action)", {
        connectionId: event.requestContext.connectionId,
        body: event.body,
    });
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
    const handlerStarted = Date.now();

    try {
        const route = wsEvent.requestContext.routeKey;
        let action = route;

        // Handle custom routes sent through the $default route by checking the body 'action' field
        if (route === "$default" && wsEvent.body) {
            try {
                const body = JSON.parse(wsEvent.body) as { action?: string };
                action = body.action || route;
            } catch (e) {
                console.warn("[ws] handler body parse failed:", (e as Error).message);
            }
        }

        console.log("[ws] handler INVOKE", {
            connectionId: wsEvent.requestContext.connectionId,
            route,
            action,
            bodyLen: wsEvent.body?.length || 0,
        });

        if (action === "$connect") return await onConnect(wsEvent);
        if (action === "$disconnect") return await onDisconnect(wsEvent);

        if (action === "sendMessage") return await onSendMessage(wsEvent);
        if (action === "getHistory") return await onGetHistory(wsEvent);
        if (action === "markRead") return await onMarkRead(wsEvent);
        if (action === "getConversations") return await onGetConversations(wsEvent);

        return await onDefault(wsEvent);
    } catch (err) {
        console.error("[ws] handler UNCAUGHT", {
            connectionId: wsEvent.requestContext.connectionId,
            error: (err as Error).message,
            stack: (err as Error).stack,
            elapsedMs: Date.now() - handlerStarted,
        });
        try {
            const connClient = wsClientFromEvent(wsEvent);
            await send(connClient, wsEvent.requestContext.connectionId, {
                type: "error",
                error: (err as Error)?.message || "Internal error",
            });
        } catch (sendErr) {
            console.error("[ws] handler error-frame send failed", { error: (sendErr as Error).message });
        }
        return { statusCode: 500, body: "Error" };
    }
};