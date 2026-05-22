import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DentiPalCDKStack } from '../lib/denti_pal_cdk-stack';
// import { ChatbotStack } from '../lib/chatbot-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const main = new DentiPalCDKStack(app, 'DentiPalCDKStackV5', { env });

// ─── Chatbot stack — TEMPORARILY DISABLED ────────────────────────────────
// Re-enable when you're ready to deploy the chatbot infrastructure
// (AgentCore Gateway + 3 AgentCore Runtime agents + ChatConversations /
// PreviewGates tables). When this block is commented out:
//   - `cdk synth` skips the runtime/ npm bundling step (no need for
//     `npm install` in runtime/ first).
//   - Main stack's chatbot-related env vars + IAM grants must ALSO be
//     commented out (search for `CHATBOT_EXPORTS` in
//     lib/denti_pal_cdk-stack.ts) — otherwise CFN deploy fails on missing
//     Fn::ImportValue exports.
//
// To re-enable:
//   1. Uncomment the import above and the `new ChatbotStack(...)` block below.
//   2. Uncomment the four `Fn.importValue(CHATBOT_EXPORTS.*)` env vars +
//      two IAM grants in lib/denti_pal_cdk-stack.ts.
//   3. `cd runtime && npm install` (one-time, creates package-lock.json).
//   4. `npx cdk deploy DentiPalChatbotStackV5` first, then
//      `npx cdk deploy DentiPalCDKStackV5` to pick up the new imports.
// ──────────────────────────────────────────────────────────────────────────
const _main = main; void _main; // silence unused warning while chatbot is off
/*
new ChatbotStack(app, 'DentiPalChatbotStackV5', {
  env,
  userPoolId: main.userPool.userPoolId,
  chatMemoryId: main.chatMemoryId,
  mainTableNames: {
    chatMessages: main.chatMessagesTable.tableName,
    chatConnections: main.chatConnectionsTable.tableName,
    connections: main.connectionsTable.tableName,
    jobPostings: main.jobPostingsTable.tableName,
    jobApplications: main.jobApplicationsTable.tableName,
    jobInvitations: main.jobInvitationsTable.tableName,
    jobNegotiations: main.jobNegotiationsTable.tableName,
    clinicProfiles: main.clinicProfilesTable.tableName,
    clinics: main.clinicsTable.tableName,
    clinicFavorites: main.clinicFavoritesTable.tableName,
    userClinicAssignments: main.userClinicAssignmentsTable.tableName,
    professionalProfiles: main.professionalProfilesTable.tableName,
    userAddresses: main.userAddressesTable.tableName,
    notificationPreferences: main.notificationPreferencesTable.tableName,
    feedback: main.feedbackTable.tableName,
    referrals: main.referralsTable.tableName,
    jobPromotions: main.jobPromotionsTable.tableName,
  },
});
*/
