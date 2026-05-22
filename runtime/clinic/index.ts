/**
 * ClinicAgent runtime entrypoint. Pinned to userType="clinic"; uses the
 * clinic tool subset defined in shared/roleAnchor.ts (~30 tools: post jobs,
 * manage applicants, hire, team management, etc.).
 */

import { startServer } from "../shared/server.js";

startServer({ agentType: "clinic" });
