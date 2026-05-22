/**
 * AgentCore Gateway construct — exposes every chat tool as an MCP target
 * pointing at a single dispatcher Lambda.
 *
 * Why this lives in its own construct rather than inline in the main stack:
 *   - It declares ~70 CfnGatewayTarget resources programmatically (one per
 *     tool with a `gateway` field in toolSchemas.ts). Keeping the loop and
 *     the per-target shape together makes the contract explicit.
 *   - When AWS adds an L2 construct for AgentCore Gateway, only this file
 *     changes — the main stack just hands in a UserPool + Lambda.
 *
 * IMPORTANT — CFN schema verification:
 *   AgentCore Gateway is brand-new (post Nov 2024). The exact property
 *   names for AWS::BedrockAgentCore::Gateway and ::GatewayTarget may shift
 *   as the service GAs. Before first deploy:
 *     1. Check `aws cloudformation describe-type --type-name AWS::BedrockAgentCore::Gateway`
 *        and ::GatewayTarget against this construct's properties.
 *     2. If property names differ, the diff is purely renames — the SHAPE
 *        of what we send (Cognito JWT auth, Lambda target with MCP schema)
 *        is correct.
 *
 * Inputs:
 *   - `userPool` — Cognito user pool; Gateway uses its JWKS URL as the
 *     CUSTOM_JWT authorizer's discovery endpoint, so the same access token
 *     the chat WebSocket validates can authorize Gateway calls.
 *   - `dispatcherLambda` — the single Lambda all Gateway targets invoke.
 *     See lambda/src/handlers/chat-gateway/wrapperDispatch.ts.
 *
 * Outputs:
 *   - `mcpUrl` — the Gateway's MCP URL. Pass to the LangGraph runtime
 *     (WS-4) as AGENTCORE_GATEWAY_MCP_URL.
 *   - `gatewayId` — for IAM grants / cross-resource refs.
 */

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { ALL_TOOLS } from "../lambda/src/handlers/chat/toolSchemas";

export interface ChatGatewayProps {
  /** Cognito user pool whose access tokens authorize Gateway calls. */
  userPool: cognito.IUserPool;
  /** Region of the user pool — used to build the JWKS discovery URL. */
  region: string;
  /** The single dispatcher Lambda every tool target invokes. */
  dispatcherLambda: lambda.IFunction;
  /** OPTIONAL: restrict accepted JWTs to this list of Cognito app client
   *  ids. Omit to accept any client in the pool. */
  allowedClientIds?: string[];
}

export class ChatGateway extends Construct {
  readonly gatewayId: string;
  readonly mcpUrl: string;

  constructor(scope: Construct, id: string, props: ChatGatewayProps) {
    super(scope, id);

    // ────────────────────────────────────────────────────────────────
    // IAM role: what Gateway assumes when invoking the dispatcher Lambda
    // ────────────────────────────────────────────────────────────────
    const gatewayRole = new iam.Role(this, "GatewayInvokeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "AgentCore Gateway → dispatcher Lambda invocation",
    });
    props.dispatcherLambda.grantInvoke(gatewayRole);

    // ────────────────────────────────────────────────────────────────
    // 1. The Gateway itself.
    //
    // ProtocolType=MCP is the only supported value at GA. Authorizer is
    // Cognito-issued JWTs — same token the chat WebSocket already verifies,
    // so the runtime agent (WS-4) just forwards its caller's token down.
    // ────────────────────────────────────────────────────────────────
    const discoveryUrl =
      `https://cognito-idp.${props.region}.amazonaws.com/${props.userPool.userPoolId}/.well-known/openid-configuration`;

    const customJwtAuthorizer: Record<string, any> = { DiscoveryUrl: discoveryUrl };
    if (props.allowedClientIds?.length) {
      customJwtAuthorizer.AllowedClients = props.allowedClientIds;
    }

    const gateway = new cdk.CfnResource(this, "DentiPalChatGateway", {
      type: "AWS::BedrockAgentCore::Gateway",
      properties: {
        // Name pattern: ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ (verify against service docs).
        Name: "DentiPal_ChatGateway",
        Description: "MCP gateway exposing DentiPal chat tools to AgentCore Runtime agents.",
        ProtocolType: "MCP",
        RoleArn: gatewayRole.roleArn,
        // CUSTOM_JWT is the AgentCore Gateway flavor that takes a generic
        // OAuth/OIDC discovery URL — exactly what Cognito's user-pool JWKS
        // endpoint exposes. AWS_IAM is the alternative but would require
        // SigV4 from the runtime, harder to wire up.
        AuthorizerType: "CUSTOM_JWT",
        AuthorizerConfiguration: { CustomJWTAuthorizer: customJwtAuthorizer },
      },
    });

    this.gatewayId = gateway.getAtt("GatewayIdentifier").toString();
    this.mcpUrl = gateway.getAtt("GatewayUrl").toString();

    // ────────────────────────────────────────────────────────────────
    // 2. One CfnGatewayTarget per tool with a `gateway` field.
    //
    // The MCP schema (name, description, inputSchema) is lifted straight
    // from toolSchemas.ts so there's no possibility of drift between what
    // the model is told and what the Gateway accepts. The dispatcher
    // Lambda receives the same tool name and reads gateway.handlerModule
    // / .method / .inputShape from the same definition — the loop here
    // doesn't pass those through, the dispatcher is single source.
    // ────────────────────────────────────────────────────────────────
    // ALL_TOOLS concatenates the per-agent registries, so any tool with
    // `scope: "both"` (get_scheduled_shifts, get_completed_shifts,
    // get_job_details, query_ddb_table, preview_negotiate / confirm_negotiate,
    // and the shared Phase-4 pairs) appears twice. Dedupe by tool name —
    // Gateway only needs one target per tool regardless of how many agents
    // advertise it.
    const wiredByName = new Map<string, typeof ALL_TOOLS[number]>();
    for (const t of ALL_TOOLS) {
      if (!t.gateway) continue;
      if (!wiredByName.has(t.name)) wiredByName.set(t.name, t);
    }
    for (const tool of wiredByName.values()) {
      // CFN logical IDs can't contain underscores or special chars in some
      // contexts — convert tool name to PascalCase for the construct id.
      const constructId = "Target" + tool.name
        .split(/[_-]/)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("");

      new cdk.CfnResource(this, constructId, {
        type: "AWS::BedrockAgentCore::GatewayTarget",
        properties: {
          GatewayIdentifier: this.gatewayId,
          Name: tool.name,
          Description: tool.description.slice(0, 1000), // CFN typically caps descriptions
          CredentialProviderConfigurations: [
            { CredentialProviderType: "GATEWAY_IAM_ROLE" },
          ],
          TargetConfiguration: {
            Mcp: {
              Lambda: {
                LambdaArn: props.dispatcherLambda.functionArn,
                // MCP tool schema — JSONSchema for inputs + the model-facing
                // description. The dispatcher reads the OTHER fields (gateway
                // routing) from toolSchemas at runtime by tool name.
                ToolSchema: {
                  InlinePayload: [{
                    Name: tool.name,
                    Description: tool.description,
                    InputSchema: tool.inputSchema,
                  }],
                },
              },
            },
          },
        },
      });
    }
  }
}
