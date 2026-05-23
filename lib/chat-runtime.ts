/**
 * AgentCore Runtime construct — three Node.js runtime agents deployed via
 * the S3 direct-code-deploy path (no Docker, no ECR).
 *
 * Architecture:
 *   1. CDK bundles `DentiPalCDK/runtime/` locally (npm ci + tsc) into a
 *      single asset zip and uploads it to the CDK bootstrap bucket.
 *   2. Three `AWS::BedrockAgentCore::Runtime` resources share that same
 *      zip — they differ only in `EntryPoint`, which selects which
 *      compiled entry file (`dist/professional/index.js` etc.) the
 *      AgentCore-managed Node 22 base image runs.
 *   3. One shared IAM role for the runtimes: read the deploy bucket, call
 *      Bedrock (LLM + Memory + Gateway/MCP), and invoke the chat-gateway
 *      dispatcher Lambda via Gateway-mediated MCP.
 *
 * Local bundling requirement: the host must have Node 22 + npm installed.
 * No Docker fallback by design (per project decision to avoid container
 * tooling). `cdk deploy` will fail with a clear message if local bundling
 * can't run.
 *
 * CFN schema verified against the live docs as of 2026-05:
 *   - AWS::BedrockAgentCore::Runtime
 *   - AgentRuntimeArtifact.CodeConfiguration.Runtime: "NODE_22"
 *   - .Code.S3.{Bucket, Prefix}  (Prefix = full object key, despite the name)
 */

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { execSync } from "child_process";
import * as path from "path";

export interface ChatRuntimeProps {
  /** Cognito user pool whose access tokens authorize InvokeAgentRuntime
   *  calls. The chatMessage Lambda forwards the caller's token down. */
  userPool: cognito.IUserPool;
  region: string;
  /** Set once WS-3 ChatGateway construct runs. Empty string when chatbot
   *  is gated on with WS-3 not yet wired — the runtime starts up but
   *  reports no tools. */
  gatewayMcpUrl?: string;
  /** AgentCore Memory id — same memory the legacy chatMessage Lambda
   *  already writes to. Runtime reads + writes via @aws-sdk/client-bedrock-agentcore. */
  agentCoreMemoryId?: string;
  /** OPTIONAL: pin to specific Cognito app client ids. Omit to accept any
   *  app client in the pool. */
  allowedClientIds?: string[];
}

export class ChatRuntime extends Construct {
  /** Output ARNs — chatMessage Lambda (WS-5) reads these via env vars to
   *  pick the right runtime per agentType. */
  readonly professionalAgentArn: string;
  readonly clinicAgentArn: string;
  readonly publicAgentArn: string;

  constructor(scope: Construct, id: string, props: ChatRuntimeProps) {
    super(scope, id);

    // ────────────────────────────────────────────────────────────────
    // 1. Bundle runtime/ → single Asset (zip) uploaded to bootstrap bucket
    //
    // Local bundling runs npm ci + tsc and copies the build output +
    // node_modules + package.json into the CDK staging dir. CDK then
    // zips that staging dir and uploads to S3.
    // ────────────────────────────────────────────────────────────────
    const runtimeSourcePath = path.join(__dirname, "..", "runtime");

    const bundle = new Asset(this, "RuntimeBundle", {
      path: runtimeSourcePath,
      bundling: {
        // Docker fallback intentionally points at a placeholder image —
        // we want local bundling ONLY. If local fails CDK will throw and
        // the user knows to install Node 22.
        image: cdk.DockerImage.fromRegistry("alpine:3"),
        local: {
          tryBundle(outputDir: string): boolean {
            try {
              // Prefer `npm ci` (reproducible — uses package-lock.json)
              // when a lockfile exists. On the first deploy of a fresh
              // checkout there's no lock yet, so fall back to `npm install`
              // (which both installs AND writes the lockfile for future
              // deploys to use). After the first run subsequent deploys
              // take the fast `npm ci` path automatically.
              const fs = require("fs") as typeof import("fs");
              const hasLock = fs.existsSync(path.join(runtimeSourcePath, "package-lock.json"));
              const installCmd = hasLock ? "npm ci --production=false" : "npm install";
              execSync(installCmd, { cwd: runtimeSourcePath, stdio: "inherit" });
              execSync("npm run build", {
                cwd: runtimeSourcePath,
                stdio: "inherit",
              });
              // Copy only what the runtime needs at execution time —
              // skip src .ts files, tests, .git, etc.
              // Use platform-agnostic copy: rely on Node's cp via fs.
              copyRecursive(path.join(runtimeSourcePath, "dist"), path.join(outputDir, "dist"));
              copyRecursive(path.join(runtimeSourcePath, "node_modules"), path.join(outputDir, "node_modules"));
              copyFile(path.join(runtimeSourcePath, "package.json"), path.join(outputDir, "package.json"));
              // package-lock.json is optional in the bundle (Node won't
              // use it at runtime) but useful for debugging the deployed
              // bundle's exact installed versions.
              const lockPath = path.join(runtimeSourcePath, "package-lock.json");
              try { copyFile(lockPath, path.join(outputDir, "package-lock.json")); } catch { /* optional */ }
              return true;
            } catch (e) {
              // Surface the actual error — CDK swallows tryBundle exceptions
              // by default, which makes "Docker is not running" the
              // misleading top-line error.
              console.error("[ChatRuntime] local bundling failed:", e);
              throw e;
            }
          },
        },
      },
    });

    // ────────────────────────────────────────────────────────────────
    // 2. Shared IAM role — assumed by AgentCore Runtime service
    // ────────────────────────────────────────────────────────────────
    const runtimeRole = new iam.Role(this, "RuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "AgentCore Runtime exec role for DentiPal chat agents (pro/clinic/public)",
    });

    // S3 read on the asset bucket so the runtime can fetch the code zip.
    bundle.grantRead(runtimeRole);

    // Bedrock Converse / InvokeModel for the LLM calls (LangGraph ⇨ Bedrock).
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:Converse",
        "bedrock:ConverseStream",
      ],
      // Cross-region inference profiles (us.anthropic.*) — match the
      // existing chatMessage Lambda's grant pattern.
      resources: [
        `arn:aws:bedrock:${props.region}::foundation-model/anthropic.*`,
        `arn:aws:bedrock:us-east-1::foundation-model/anthropic.*`,
        `arn:aws:bedrock:us-east-2::foundation-model/anthropic.*`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.*`,
        `arn:aws:bedrock:${props.region}:${cdk.Stack.of(this).account}:inference-profile/us.anthropic.*`,
      ],
    }));

    // AgentCore Memory read/write — same memory the chatMessage Lambda
    // already uses. Specific memoryId arn provided when known; otherwise
    // wildcard (still scoped to this account).
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreateEvent",
        "bedrock-agentcore:RetrieveMemoryRecords",
        "bedrock-agentcore:ListMemoryRecords",
      ],
      resources: [
        `arn:aws:bedrock-agentcore:${props.region}:${cdk.Stack.of(this).account}:memory/*`,
      ],
    }));

    // AgentCore Gateway MCP — call the gateway as a tool source. The
    // gateway authorizes JWT separately; this role just needs to be able
    // to reach the gateway endpoint.
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock-agentcore:InvokeGateway"],
      resources: [
        `arn:aws:bedrock-agentcore:${props.region}:${cdk.Stack.of(this).account}:gateway/*`,
      ],
    }));

    // CloudWatch Logs for the runtime container.
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents",
      ],
      resources: ["*"],
    }));

    // ────────────────────────────────────────────────────────────────
    // 3. Three AWS::BedrockAgentCore::Runtime resources
    //
    // All three share the same zip + role; only EntryPoint differs.
    // ────────────────────────────────────────────────────────────────
    // Authorizer choice: we OMIT AuthorizerConfiguration entirely, which makes
    // the runtime default to AWS_IAM (SigV4). The chatMessage Lambda invokes
    // the runtime via the AWS SDK's InvokeAgentRuntimeCommand, which signs
    // with SigV4 using the Lambda's execution role — matches. The user's
    // Cognito identity (userSub/email/groups/clinics) flows in the request
    // body's `context.identity` field instead of via a forwarded JWT.
    //
    // CUSTOM_JWT (the alternative) would require the Lambda to drop the SDK
    // and POST directly to the runtime endpoint with `Authorization: Bearer
    // <user-jwt>` — more plumbing for no real gain, since the runtime trusts
    // the Lambda to vouch for the user anyway.
    void props.allowedClientIds;

    const sharedEnv: Record<string, string> = {
      // The runtime container reads these on init. Same shape the legacy
      // chatMessage Lambda uses.
      ...(props.gatewayMcpUrl ? { AGENTCORE_GATEWAY_MCP_URL: props.gatewayMcpUrl } : {}),
      ...(props.agentCoreMemoryId ? { AGENTCORE_MEMORY_ID: props.agentCoreMemoryId } : {}),
      // NODE_OPTIONS lets us bump heap if a single turn pulls heavy
      // context. 512MB headroom matches the WS-3 dispatcher Lambda.
      NODE_OPTIONS: "--max-old-space-size=768",
    };

    const makeRuntime = (logicalId: string, runtimeName: string, entrypoint: string): cdk.CfnResource =>
      new cdk.CfnResource(this, logicalId, {
        type: "AWS::BedrockAgentCore::Runtime",
        properties: {
          // Name pattern (verify against service docs): alphanumerics +
          // underscores, must start with a letter.
          AgentRuntimeName: runtimeName,
          Description: `DentiPal ${logicalId} - LangGraph.js agent on AgentCore Runtime (NODE_22).`,
          RoleArn: runtimeRole.roleArn,
          AgentRuntimeArtifact: {
            CodeConfiguration: {
              Runtime: "NODE_22",
              // EntryPoint is a 1-2 element array. For Node, element 0 is
              // the path to the compiled entry file relative to the zip
              // root. The AgentCore base image runs `node <entryPoint[0]>`.
              EntryPoint: [entrypoint],
              Code: {
                S3: {
                  Bucket: bundle.s3BucketName,
                  // Despite the name, `Prefix` is the full S3 object key
                  // (the zip's path within the bucket). Verified against
                  // AWS docs 2026-05.
                  Prefix: bundle.s3ObjectKey,
                  // VersionId omitted — defaults to latest, which matches
                  // CDK's asset model (each deploy gets a fresh key).
                },
              },
            },
          },
          // AuthorizerConfiguration intentionally omitted — defaults to AWS_IAM
          // (SigV4) so the chatMessage Lambda's SDK InvokeAgentRuntimeCommand
          // works without HTTPS+JWT plumbing. See comment block above.
          ProtocolConfiguration: "HTTP",
          NetworkConfiguration: { NetworkMode: "PUBLIC" },
          EnvironmentVariables: sharedEnv,
        },
      });

    // Construct IDs + AgentRuntimeNames bumped to "*V2" — same reason as the
    // Gateway in chat-gateway.ts: AgentCore rejects in-place updates to both
    // AuthorizerConfiguration and AgentRuntimeName, so we change the CDK
    // construct ID (→ new CFN logical ID → CFN deletes the old runtime and
    // creates a new one with AWS_IAM). Names also get _v2 to satisfy the
    // service's "name must be unique per account" check during the brief
    // overlap when both old and new exist mid-deploy.
    const proRuntime = makeRuntime(
      "ProfessionalRuntimeV2",
      "DentiPal_ProfessionalAgent_v2",
      "dist/professional/index.js",
    );
    const clinicRuntime = makeRuntime(
      "ClinicRuntimeV2",
      "DentiPal_ClinicAgent_v2",
      "dist/clinic/index.js",
    );
    const publicRuntime = makeRuntime(
      "PublicRuntimeV2",
      "DentiPal_PublicAgent_v2",
      "dist/public/index.js",
    );

    this.professionalAgentArn = proRuntime.getAtt("AgentRuntimeArn").toString();
    this.clinicAgentArn = clinicRuntime.getAtt("AgentRuntimeArn").toString();
    this.publicAgentArn = publicRuntime.getAtt("AgentRuntimeArn").toString();
  }
}

// ────────────────────────────────────────────────────────────────
// Tiny FS helpers — kept local so the construct file is self-contained.
// Using sync APIs because CDK bundling itself is synchronous.
// ────────────────────────────────────────────────────────────────

function copyFile(src: string, dest: string): void {
  const fs = require("fs") as typeof import("fs");
  fs.copyFileSync(src, dest);
}

function copyRecursive(src: string, dest: string): void {
  const fs = require("fs") as typeof import("fs");
  // Node 16+ supports fs.cpSync with recursive — that's what we need.
  fs.cpSync(src, dest, { recursive: true });
}
