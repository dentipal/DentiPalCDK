/**
 * Chatbot infrastructure — split out from DentiPalCDKStack so all of the
 * chatbot's CDK lives in one file.
 *
 * Dependency direction: this stack does NOT reference main-stack constructs
 * directly. It receives every cross-stack value as a STRING (table name,
 * user pool id, etc.) and rebuilds local handles via `fromTableName` /
 * `fromUserPoolId`. This keeps the dependency one-way (main reads from
 * chatbot via Fn.importValue; chatbot reads from main only via the
 * hardcoded strings passed at instantiation time).
 *
 * What lives here:
 *   - Brand-new tables: ChatConversations, PreviewGates.
 *   - AgentCore Gateway (one CfnGateway + ~70 CfnGatewayTargets) + the
 *     dispatcher Lambda the targets all invoke.
 *   - AgentCore Runtime (three Node.js runtime agents via S3 direct-deploy).
 *   - CfnOutputs for the runtime ARNs + chatbot table names, which the
 *     main stack consumes via Fn.importValue to set env vars + IAM grants
 *     on its own chatMessage / monolith Lambdas.
 *
 * What stays in the main stack (and why we don't move it):
 *   - `chatMessageHandler` Lambda + monolith Lambda (already deployed with
 *     fixed function names — moving would require `cdk import`).
 *   - `chatMessagesTable`, `chatConnectionsTable`, AgentCore Memory
 *     (already deployed with live data).
 *   - WebSocket API + chatMessage route binding.
 *   - Cognito user pool (the platform's identity provider).
 *
 * Main-stack mutations (env vars on chatMessage / monolith Lambdas, IAM
 * grants for chatbot tables / runtime ARNs) live in main-stack code and
 * read from this stack's CfnOutputs via Fn.importValue. See
 * `wireChatbotIntoMain` at the bottom of lib/denti_pal_cdk-stack.ts.
 */

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as path from "path";
import { ChatGateway } from "./chat-gateway";
import { ChatRuntime } from "./chat-runtime";
import { ChatBedrockAgents } from "./chat-bedrock-agents";

export interface ChatbotStackProps extends cdk.StackProps {
  /** Cognito user pool ID (string, NOT a construct reference). The chatbot
   *  stack rebuilds an IUserPool via `fromUserPoolId` so there's no CFN
   *  cross-stack dependency on main. */
  userPoolId: string;

  /** Cognito user-pool app client ID. AgentCore's CUSTOM_JWT authorizer (which
   *  is really standard Cognito-OIDC, not anything custom) requires at least
   *  one of allowedClients/allowedAudience/allowedScopes/CustomClaims — we
   *  use allowedClients so only tokens issued for our app client are accepted. */
  userPoolClientId: string;

  /** AgentCore Memory id (CFN attribute, passed by main stack at synth time
   *  via main.chatMemoryId — string-valued, no construct ref). */
  chatMemoryId: string;

  /** Table NAMES from main stack — all explicit & known at synth time
   *  (DentiPal-V5-...). We construct ITable refs via fromTableName for
   *  grantReadWriteData calls on the dispatcher's role. */
  mainTableNames: {
    chatMessages: string;
    chatConnections: string;
    connections: string;
    jobPostings: string;
    jobApplications: string;
    jobInvitations: string;
    jobNegotiations: string;
    clinicProfiles: string;
    clinics: string;
    clinicFavorites: string;
    userClinicAssignments: string;
    professionalProfiles: string;
    userAddresses: string;
    notificationPreferences: string;
    feedback: string;
    referrals: string;
    jobPromotions: string;
  };
}

/** Stable CfnOutput export names — main stack reads these via Fn.importValue. */
export const CHATBOT_EXPORTS = {
  previewGatesTableName: "DentiPalPreviewGatesTableName",
  previewGatesTableArn: "DentiPalPreviewGatesTableArn",
  chatConversationsTableName: "DentiPalChatConversationsTableName",
  chatConversationsTableArn: "DentiPalChatConversationsTableArn",
  professionalAgentArn: "DentiPalProfessionalAgentRuntimeArn",
  clinicAgentArn: "DentiPalClinicAgentRuntimeArn",
  publicAgentArn: "DentiPalPublicAgentRuntimeArn",
  gatewayMcpUrl: "DentiPalChatGatewayMcpUrl",
  // Bedrock Agents IDs + aliases (Deploy 1 of the hybrid migration).
  // Read by the runtime container's orchestrator to call InvokeAgent.
  bedrockProAgentId: "DentiPalBedrockProAgentId",
  bedrockClinicAgentId: "DentiPalBedrockClinicAgentId",
  bedrockPublicAgentId: "DentiPalBedrockPublicAgentId",
  bedrockProAgentAliasId: "DentiPalBedrockProAgentAliasId",
  bedrockClinicAgentAliasId: "DentiPalBedrockClinicAgentAliasId",
  bedrockPublicAgentAliasId: "DentiPalBedrockPublicAgentAliasId",
} as const;

export class ChatbotStack extends cdk.Stack {
  readonly chatConversationsTable: dynamodb.Table;
  readonly previewGatesTable: dynamodb.Table;
  readonly chatGateway: ChatGateway;
  readonly chatRuntime: ChatRuntime;
  readonly chatBedrockAgents: ChatBedrockAgents;

  constructor(scope: Construct, id: string, props: ChatbotStackProps) {
    super(scope, id, props);

    // ────────────────────────────────────────────────────────────────
    // Rebuild handles to main-stack resources from strings — these are
    // IXxx (read-only) refs that don't create CFN cross-stack
    // dependencies, because the underlying strings are literal at synth
    // time (no Fn::ImportValue, no Ref).
    // ────────────────────────────────────────────────────────────────
    const userPool = cognito.UserPool.fromUserPoolId(this, "ImportedUserPool", props.userPoolId);
    const t = props.mainTableNames;
    const mainChatMessages = dynamodb.Table.fromTableName(this, "ImportedChatMessages", t.chatMessages);
    const mainChatConnections = dynamodb.Table.fromTableName(this, "ImportedChatConnections", t.chatConnections);
    const mainConnections = dynamodb.Table.fromTableName(this, "ImportedConnections", t.connections);
    const mainJobPostings = dynamodb.Table.fromTableName(this, "ImportedJobPostings", t.jobPostings);
    const mainJobApplications = dynamodb.Table.fromTableName(this, "ImportedJobApplications", t.jobApplications);
    const mainJobInvitations = dynamodb.Table.fromTableName(this, "ImportedJobInvitations", t.jobInvitations);
    const mainJobNegotiations = dynamodb.Table.fromTableName(this, "ImportedJobNegotiations", t.jobNegotiations);
    const mainClinicProfiles = dynamodb.Table.fromTableName(this, "ImportedClinicProfiles", t.clinicProfiles);
    const mainClinics = dynamodb.Table.fromTableName(this, "ImportedClinics", t.clinics);
    const mainClinicFavorites = dynamodb.Table.fromTableName(this, "ImportedClinicFavorites", t.clinicFavorites);
    const mainUserClinicAssignments = dynamodb.Table.fromTableName(this, "ImportedUserClinicAssignments", t.userClinicAssignments);
    const mainProfessionalProfiles = dynamodb.Table.fromTableName(this, "ImportedProfessionalProfiles", t.professionalProfiles);
    const mainUserAddresses = dynamodb.Table.fromTableName(this, "ImportedUserAddresses", t.userAddresses);
    const mainNotificationPreferences = dynamodb.Table.fromTableName(this, "ImportedNotificationPreferences", t.notificationPreferences);
    const mainFeedback = dynamodb.Table.fromTableName(this, "ImportedFeedback", t.feedback);
    const mainReferrals = dynamodb.Table.fromTableName(this, "ImportedReferrals", t.referrals);
    const mainJobPromotions = dynamodb.Table.fromTableName(this, "ImportedJobPromotions", t.jobPromotions);

    // ────────────────────────────────────────────────────────────────
    // Tables (new — no migration concerns)
    // ────────────────────────────────────────────────────────────────

    this.chatConversationsTable = new dynamodb.Table(this, "ChatConversationsTable", {
      tableName: "DentiPal-V5-ChatConversations",
      partitionKey: { name: "userSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "conversationId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.chatConversationsTable.addGlobalSecondaryIndex({
      indexName: "userSub-lastMessageAt-index",
      partitionKey: { name: "userSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "lastMessageAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.previewGatesTable = new dynamodb.Table(this, "PreviewGatesTable", {
      tableName: "DentiPal-V5-PreviewGates",
      partitionKey: { name: "userSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "previewToken", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });

    // ────────────────────────────────────────────────────────────────
    // AgentCore Gateway dispatcher Lambda
    // ────────────────────────────────────────────────────────────────

    const chatGatewayDispatcher = new lambda.Function(this, "ChatGatewayDispatcher", {
      functionName: "DentiPal-ChatGateway-Dispatcher",
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "dist/handlers/chat-gateway/wrapperDispatch.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      timeout: cdk.Duration.seconds(30),
      memorySize: 1024,
      environment: {
        REGION: this.region,
        USER_POOL_ID: props.userPoolId,
        PREVIEW_GATES_TABLE: this.previewGatesTable.tableName,
        CONNS_TABLE: t.connections,
        MESSAGES_TABLE: t.chatMessages,
        CLINIC_PROFILES_TABLE: t.clinicProfiles,
        CLINIC_FAVORITES_TABLE: t.clinicFavorites,
        CLINICS_TABLE: t.clinics,
        FEEDBACK_TABLE: t.feedback,
        JOB_APPLICATIONS_TABLE: t.jobApplications,
        APPLICATIONS_TABLE: t.jobApplications,
        JOB_INVITATIONS_TABLE: t.jobInvitations,
        JOB_NEGOTIATIONS_TABLE: t.jobNegotiations,
        JOB_POSTINGS_TABLE: t.jobPostings,
        PROFESSIONAL_PROFILES_TABLE: t.professionalProfiles,
        REFERRALS_TABLE: t.referrals,
        USER_ADDRESSES_TABLE: t.userAddresses,
        USER_CLINIC_ASSIGNMENTS_TABLE: t.userClinicAssignments,
        NOTIFICATION_PREFERENCES_TABLE: t.notificationPreferences,
        JOB_PROMOTIONS_TABLE: t.jobPromotions,
      },
    });

    // DDB grants for the dispatcher. The `fromTableName`-derived ITables
    // know their own ARN (table.tableArn resolves via Arn.format with the
    // known name) so grantReadWriteData works without creating a
    // construct-level cross-stack dep.
    mainChatConnections.grantReadWriteData(chatGatewayDispatcher);
    mainChatMessages.grantReadWriteData(chatGatewayDispatcher);
    this.previewGatesTable.grantReadWriteData(chatGatewayDispatcher);
    this.chatConversationsTable.grantReadWriteData(chatGatewayDispatcher);
    mainConnections.grantReadData(chatGatewayDispatcher);
    mainJobPostings.grantReadWriteData(chatGatewayDispatcher);
    mainJobApplications.grantReadWriteData(chatGatewayDispatcher);
    mainJobInvitations.grantReadWriteData(chatGatewayDispatcher);
    mainJobNegotiations.grantReadWriteData(chatGatewayDispatcher);
    mainClinicProfiles.grantReadWriteData(chatGatewayDispatcher);
    mainClinics.grantReadWriteData(chatGatewayDispatcher);
    mainClinicFavorites.grantReadWriteData(chatGatewayDispatcher);
    mainUserClinicAssignments.grantReadWriteData(chatGatewayDispatcher);
    mainProfessionalProfiles.grantReadWriteData(chatGatewayDispatcher);
    mainUserAddresses.grantReadWriteData(chatGatewayDispatcher);
    mainNotificationPreferences.grantReadWriteData(chatGatewayDispatcher);
    mainFeedback.grantReadWriteData(chatGatewayDispatcher);
    mainReferrals.grantReadWriteData(chatGatewayDispatcher);
    mainJobPromotions.grantReadWriteData(chatGatewayDispatcher);

    chatGatewayDispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:AdminGetUser", "cognito-idp:AdminListGroupsForUser"],
      resources: [userPool.userPoolArn],
    }));

    // EventBridge PutEvents on the default bus -- several handlers fan out
    // domain events on write (respondToInvitation -> "invitation.accepted",
    // createJobApplication -> "application.created", acceptProf ->
    // "professional.hired", etc.) that downstream rules pick up to send
    // emails / SMS / push notifications. Without this grant the handler
    // logic completes but the PutEvents call raises AccessDenied, the
    // handler catches it as Internal Server Error, and the chat surfaces
    // it as a generic failure -- masking the fact that the actual write
    // already happened (so the user retrying may double-act).
    //
    // Scoped to the default bus only; refactor to a named bus + per-source
    // scoping later if event volume grows.
    chatGatewayDispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["events:PutEvents"],
      resources: [`arn:aws:events:${this.region}:${this.account}:event-bus/default`],
    }));

    // GSI access. dynamodb.Table.fromTableName creates an ITable that only
    // knows the base table ARN — grantReadWriteData scopes IAM to
    // table/<name>, NOT table/<name>/index/*. Tools that query a GSI (e.g.
    // search_jobs_near_me hits professionalUserSub-index on JobApplications)
    // then fail with AccessDenied. Blanket-grant Query/Scan on every
    // index/* under the tables the dispatcher touches.
    chatGatewayDispatcher.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:Query", "dynamodb:Scan"],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.chatMessages}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.chatConnections}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.connections}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.jobPostings}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.jobApplications}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.jobInvitations}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.jobNegotiations}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.clinicProfiles}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.clinics}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.clinicFavorites}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.userClinicAssignments}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.professionalProfiles}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.userAddresses}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.notificationPreferences}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.feedback}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.referrals}/index/*`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/${t.jobPromotions}/index/*`,
        // Two tables the chatbot owns directly.
        `${this.chatConversationsTable.tableArn}/index/*`,
        `${this.previewGatesTable.tableArn}/index/*`,
      ],
    }));

    // ────────────────────────────────────────────────────────────────
    // AgentCore Gateway + Runtime constructs
    // ────────────────────────────────────────────────────────────────

    this.chatGateway = new ChatGateway(this, "DentiPalChatGateway", {
      userPool,
      region: this.region,
      dispatcherLambda: chatGatewayDispatcher,
      allowedClientIds: [props.userPoolClientId],
    });

    // Bedrock Agents (managed agent loop) — declared BEFORE ChatRuntime
    // because the orchestrator inside the runtime container needs the
    // agent IDs as env vars.
    this.chatBedrockAgents = new ChatBedrockAgents(this, "ChatBedrockAgents", {
      dispatcherLambda: chatGatewayDispatcher,
    });

    this.chatRuntime = new ChatRuntime(this, "DentiPalChatRuntime", {
      userPool,
      region: this.region,
      gatewayMcpUrl: this.chatGateway.mcpUrl,
      agentCoreMemoryId: props.chatMemoryId,
      allowedClientIds: [props.userPoolClientId],
      bedrockProAgentId: this.chatBedrockAgents.professionalAgentId,
      bedrockProAgentAliasId: this.chatBedrockAgents.professionalAgentAliasId,
      bedrockClinicAgentId: this.chatBedrockAgents.clinicAgentId,
      bedrockClinicAgentAliasId: this.chatBedrockAgents.clinicAgentAliasId,
      bedrockPublicAgentId: this.chatBedrockAgents.publicAgentId,
      bedrockPublicAgentAliasId: this.chatBedrockAgents.publicAgentAliasId,
    });

    // ────────────────────────────────────────────────────────────────
    // CfnOutputs with stable export names — main stack reads these via
    // Fn.importValue to wire its own chatMessage / monolith Lambdas.
    // ────────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "ChatGatewayMcpUrlOut", {
      exportName: CHATBOT_EXPORTS.gatewayMcpUrl,
      value: this.chatGateway.mcpUrl,
      description: "AGENTCORE_GATEWAY_MCP_URL - for any caller that needs to address Gateway directly.",
    });
    new cdk.CfnOutput(this, "PreviewGatesTableNameOut", {
      exportName: CHATBOT_EXPORTS.previewGatesTableName,
      value: this.previewGatesTable.tableName,
    });
    new cdk.CfnOutput(this, "PreviewGatesTableArnOut", {
      exportName: CHATBOT_EXPORTS.previewGatesTableArn,
      value: this.previewGatesTable.tableArn,
    });
    new cdk.CfnOutput(this, "ChatConversationsTableNameOut", {
      exportName: CHATBOT_EXPORTS.chatConversationsTableName,
      value: this.chatConversationsTable.tableName,
    });
    new cdk.CfnOutput(this, "ChatConversationsTableArnOut", {
      exportName: CHATBOT_EXPORTS.chatConversationsTableArn,
      value: this.chatConversationsTable.tableArn,
    });
    // TEMP keepalive: forces the chatbot template to keep its Fn::ImportValue
    // reference to main's userPoolClientId export. Without this, CDK strips
    // the unused import (we no longer pass allowedClientIds to Gateway/Runtime
    // since the AWS_IAM switch), and main's UPDATE then fails with "Cannot
    // delete export ... as it is in use by chatbot." Safe to remove after the
    // first successful deploy where both stacks settle.
    new cdk.CfnOutput(this, "UserPoolClientIdKeepalive", {
      value: props.userPoolClientId,
      description: "Transition keepalive — see comment in chatbot-stack.ts; remove once both stacks have settled on AWS_IAM.",
    });
    new cdk.CfnOutput(this, "ProfessionalAgentRuntimeArnOut", {
      exportName: CHATBOT_EXPORTS.professionalAgentArn,
      value: this.chatRuntime.professionalAgentArn,
    });
    new cdk.CfnOutput(this, "ClinicAgentRuntimeArnOut", {
      exportName: CHATBOT_EXPORTS.clinicAgentArn,
      value: this.chatRuntime.clinicAgentArn,
    });
    new cdk.CfnOutput(this, "PublicAgentRuntimeArnOut", {
      exportName: CHATBOT_EXPORTS.publicAgentArn,
      value: this.chatRuntime.publicAgentArn,
    });

    // Bedrock Agents IDs + alias IDs — exported so the runtime container
    // (Deploy 3) can read them as env vars and call InvokeAgent.
    new cdk.CfnOutput(this, "BedrockProAgentIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockProAgentId,
      value: this.chatBedrockAgents.professionalAgentId,
    });
    new cdk.CfnOutput(this, "BedrockClinicAgentIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockClinicAgentId,
      value: this.chatBedrockAgents.clinicAgentId,
    });
    new cdk.CfnOutput(this, "BedrockPublicAgentIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockPublicAgentId,
      value: this.chatBedrockAgents.publicAgentId,
    });
    new cdk.CfnOutput(this, "BedrockProAgentAliasIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockProAgentAliasId,
      value: this.chatBedrockAgents.professionalAgentAliasId,
    });
    new cdk.CfnOutput(this, "BedrockClinicAgentAliasIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockClinicAgentAliasId,
      value: this.chatBedrockAgents.clinicAgentAliasId,
    });
    new cdk.CfnOutput(this, "BedrockPublicAgentAliasIdOut", {
      exportName: CHATBOT_EXPORTS.bedrockPublicAgentAliasId,
      value: this.chatBedrockAgents.publicAgentAliasId,
    });
  }
}
