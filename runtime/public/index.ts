/**
 * PublicAgent runtime entrypoint. Pinned to userType="public" — no tools
 * advertised, no memory writes (anon userSubs rotate per connection).
 * Pure conversational landing-page assistant.
 */

import { startServer } from "../shared/server.js";

startServer({ agentType: "public" });
