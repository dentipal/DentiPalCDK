/**
 * ProfessionalAgent runtime entrypoint.
 *
 * Deployed to AgentCore Runtime via S3 direct-code-deploy (NODE_22). The
 * AWS-provided base image fuses with this code at deploy time and runs
 * the compiled `dist/professional/index.js` as the entry point.
 *
 * Only role-specific concern: the agentType is pinned to "professional"
 * so this runtime will refuse to run any invocation that claimed a
 * different role. Pro tool subset is selected by `shared/roleAnchor.ts`
 * based on that pinned type.
 */

import { startServer } from "../shared/server.js";

startServer({ agentType: "professional" });
