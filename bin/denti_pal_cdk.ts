import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DentiPalCDKStack } from '../lib/denti_pal_cdk-stack';
import { ChatbotStack } from '../lib/chatbot-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const main = new DentiPalCDKStack(app, 'DentiPalCDKStackV5', { env });

// Chatbot stack — all new chatbot infrastructure (ChatGateway, ChatRuntime,
// ChatConversations + PreviewGates tables, Gateway dispatcher Lambda) lives
// here. Strict one-way dependency: chatbot is independent at the CFN level
// (no Fn::ImportValue references back to main); main reads chatbot's
// outputs via Fn.importValue to wire env vars + IAM on its own Lambdas.
//
// We pass cross-stack strings (table names, user pool id) rather than
// construct refs because construct refs would generate Fn::ImportValue
// chatbot→main and combined with main→chatbot would cycle.
new ChatbotStack(app, 'DentiPalChatbotStackV5', {
  env,
  userPoolId: main.userPool.userPoolId,
  userPoolClientId: main.userPoolClientId,
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
