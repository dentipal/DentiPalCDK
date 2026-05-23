/**
 * AgentCore Gateway (MCP) tool integration for the LangGraph agents.
 *
 * The Gateway exposes ~70 DentiPal tools over the Model Context Protocol;
 * we discover them at container startup and wrap each as a LangChain
 * `DynamicStructuredTool` so LangGraph's ReAct/tool-calling node can invoke
 * them. The wrapping injects the AuthContext (userSub + clinic cache)
 * automatically — agent code never has to thread it through tool calls.
 *
 * Lifecycle:
 *   - One MCP client per container, established lazily on first invocation.
 *   - The discovered tool list is cached for the container's warm lifetime
 *     — re-discovery is cheap but pointless since toolSchemas.ts is the
 *     source of truth and changes only on deploys (which restart the
 *     container).
 *   - Each tool's `func` calls `client.callTool({ name, arguments })` and
 *     returns the result body to the LLM.
 */

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { AuthContext } from "./auth.js";

const GATEWAY_MCP_URL = process.env.AGENTCORE_GATEWAY_MCP_URL || "";

let cachedClient: MCPClient | null = null;
let cachedTools: Array<{ name: string; description: string; inputSchema: Record<string, any> }> | null = null;

/**
 * Connect to the Gateway and list available tools. Idempotent — repeated
 * calls return the cached state for the warm container lifetime.
 *
 * Returns an empty list (with a warning log) when the env var isn't set,
 * so the agent starts up gracefully in test environments where the Gateway
 * isn't wired yet. The agents themselves degrade to "no tools" mode in
 * that case — they can still answer questions but not invoke handlers.
 */
export async function ensureMcpClient(): Promise<{
  client: MCPClient | null;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, any> }>;
}> {
  if (cachedClient && cachedTools) return { client: cachedClient, tools: cachedTools };

  if (!GATEWAY_MCP_URL) {
    console.warn("[mcpTools] AGENTCORE_GATEWAY_MCP_URL not set; tools will be unavailable.");
    cachedTools = [];
    return { client: null, tools: [] };
  }

  try {
    const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_MCP_URL));
    const client = new MCPClient(
      { name: "dentipal-runtime", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    const list = await client.listTools();
    cachedClient = client;
    cachedTools = (list.tools || []).map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: (t.inputSchema as Record<string, any>) || { type: "object", properties: {} },
    }));
    return { client: cachedClient, tools: cachedTools };
  } catch (e: any) {
    console.warn("[mcpTools] failed to connect to Gateway MCP:", e?.message || e);
    cachedTools = [];
    return { client: null, tools: [] };
  }
}

/**
 * Build LangChain tools that LangGraph's tool-calling node can dispatch.
 * Each wrapper:
 *   1. Validates input is an object (LangGraph passes the parsed JSON).
 *   2. Forwards to Gateway via MCP `callTool`.
 *   3. Returns the result body as a string (LangChain convention for tool
 *      outputs that become the next prompt's tool-result block).
 *
 * Filtering: `allowedTools` restricts the surface — pass the per-agent
 * subset (pro vs clinic vs none) so the LLM only sees tools relevant to
 * the caller. Names not in `allowedTools` are silently dropped from the
 * returned array.
 */
export async function buildMcpTools(opts: {
  auth: AuthContext;
  conversationId?: string;
  allowedTools: Set<string>;
}): Promise<DynamicStructuredTool[]> {
  const { client, tools } = await ensureMcpClient();
  if (!client) return [];

  return tools
    .filter((t) => opts.allowedTools.has(t.name))
    .map((t) => {
      return new DynamicStructuredTool({
        name: t.name,
        description: t.description,
        // LangGraph wants a Zod schema; we use `z.any()` because the MCP
        // schema is JSON-Schema, which Zod can't natively consume. The LLM
        // sees the proper JSONSchema in the tool description below via
        // LangChain's bind-tools serialization (handled by the model
        // provider). Wide acceptance here is safe — Gateway re-validates
        // against the actual schema on the way in.
        schema: z.object({}).passthrough(),
        func: async (input: Record<string, any>) => {
          try {
            const result = await client.callTool({
              name: t.name,
              arguments: {
                ...input,
                // Per-call context envelope — Gateway's dispatcher uses
                // this to populate the AuthContext on the underlying
                // Lambda invocation. Mirrors what chatMessage.ts puts in
                // `_inProcessAuth` for in-process handler calls.
                _context: {
                  identity: {
                    userSub: opts.auth.userSub,
                    userType: opts.auth.userType,
                    userGroups: opts.auth.userGroups,
                    email: opts.auth.email,
                    clinics: opts.auth.clinics,
                  },
                  session: {
                    conversationId: opts.conversationId,
                  },
                },
              },
            });
            // MCP returns `content: [{ type: "text", text: "..."}]`; we
            // unwrap so the LLM sees the raw JSON it expects.
            const content = (result as any).content;
            if (Array.isArray(content) && content[0]?.type === "text") {
              return content[0].text;
            }
            return JSON.stringify(result);
          } catch (e: any) {
            // Tool errors come back as a stringified error — the LLM will
            // see them, can reason about retry / different tool, etc.
            return JSON.stringify({ error: e?.message || String(e) });
          }
        },
      });
    });
}
