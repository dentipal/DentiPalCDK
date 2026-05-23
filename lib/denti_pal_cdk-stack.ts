// import * as cdk from 'aws-cdk-lib';
// import { Construct } from 'constructs';
// import * as cognito from 'aws-cdk-lib/aws-cognito';
// import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
// import * as lambda from 'aws-cdk-lib/aws-lambda';
// import * as apigateway from 'aws-cdk-lib/aws-apigateway';
// import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
// import * as apigwv2integrations from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
// import * as iam from 'aws-cdk-lib/aws-iam';
// import * as s3 from 'aws-cdk-lib/aws-s3';
// import * as path from 'path';

// export class DentiPalCDKStack extends cdk.Stack {
//   constructor(scope: Construct, id: string, props?: cdk.StackProps) {
//     super(scope, id, props);

//     // ========================================================================
//     // 1. Cognito User Pool
//     // ========================================================================
//     const userPool = new cognito.UserPool(this, 'ClinicUserPoolV5', {
//       selfSignUpEnabled: true,
//       autoVerify: { email: true },
//       standardAttributes: {
//         givenName: { required: true, mutable: true },
//         familyName: { required: true, mutable: true },
//         phoneNumber: { required: true, mutable: true },
//         email: { required: true, mutable: true },
//         address: { required: true, mutable: true },
//       },
//       signInAliases: { email: true },
//       passwordPolicy: {
//         minLength: 8,
//         requireDigits: true,
//         requireLowercase: true,
//         requireUppercase: true,
//         requireSymbols: true,
//       },
//       removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for prod
//     });

//     const client = userPool.addClient('ClinicAppClientV5', {
//       authFlows: { userPassword: true, userSrp: true },
//       preventUserExistenceErrors: true,
//     });

//     const groups = [
//       'Root',
//       'ClinicAdmin', // Simplified group names for use in CfnUserPoolGroup
//       'ClinicManager',
//       'ClinicViewer',
//       'AssociateDentist',
//       'DentalAssistant',
//       'DualRoleFrontDA', // Mapping 'Front Desk/DA'
//       'Dental Hygienist', // Mapping 'Hygienist'
//       // You should adjust the groups in the CfnUserPoolGroup list 
//       // to match the exact strings used in your Lambda code for authorization.
//     ];

//     // Note: The CfnUserPoolGroup names were simplified for the loop to avoid special chars
//     // Cognito group names cannot contain spaces - use underscores or camelCase
//     const cognitoGroups = [
//         'Root',
//         'ClinicAdmin',
//         'ClinicManager',
//         'ClinicViewer',
//         'AssociateDentist',
//         'DentalAssistant',
//         'DualRoleFrontDA',
//         'DentalHygienist',
//         'FrontDesk',
//         'Dentist',
//     ];

//     cognitoGroups.forEach(group => {
//       new cognito.CfnUserPoolGroup(this, `Group${group.replace(/[\s/]/g, '')}`, {
//         userPoolId: userPool.userPoolId,
//         groupName: group,
//       });
//     });

//     // ========================================================================
//     // 2. DynamoDB Tables & GSIs
//     // ========================================================================

//     // Reusing the table definitions from your original stack
//     // (A full list of tables is omitted here for brevity, assuming they are unchanged)

//     // 1. DentiPal-Clinic-Profiles
//     const clinicProfilesTable = new dynamodb.Table(this, 'ClinicProfilesTable', {
//         tableName: 'DentiPal-V5-Clinic-Profiles',
//         partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       clinicProfilesTable.addGlobalSecondaryIndex({
//         indexName: 'userSub-index',
//         partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 2. DentiPal-ClinicFavorites
//       const clinicFavoritesTable = new dynamodb.Table(this, 'ClinicFavoritesTable', {
//         tableName: 'DentiPal-V5-ClinicFavorites',
//         partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 3. DentiPal-Clinics
//       const clinicsTable = new dynamodb.Table(this, 'ClinicsTable', {
//         tableName: 'DentiPal-V5-Clinics',
//         partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       clinicsTable.addGlobalSecondaryIndex({
//         indexName: 'CreatedByIndex',
//         partitionKey: { name: 'createdBy', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 4. DentiPal-Connections (Used by WebSocket Handler)
//       const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
//         tableName: 'DentiPal-V5-Connections',
//         partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       // The original stack had multiple indexes with potentially similar names, 
//       // ensuring unique index names for the CDK construct:
//       connectionsTable.addGlobalSecondaryIndex({
//         indexName: 'connectionId-index',
//         partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       // Note: The original stack had clinicKey-index and profKey-index listed but 
//       // these columns don't appear in the ConnectionsTable definition provided 
//       // (only userKey and connectionId). Assuming the connectionId-index is what 
//       // is primarily needed for lookups by ID. I've removed the redundant or 
//       // potentially misleading indices from the CDK code.

//       // 5. DentiPal-Conversations (Used by WebSocket Handler)
//       const conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
//         tableName: 'DentiPal-V5-Conversations',
//         partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       conversationsTable.addGlobalSecondaryIndex({
//         indexName: 'clinicKey-lastMessageAt',
//         partitionKey: { name: 'clinicKey', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.NUMBER },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       conversationsTable.addGlobalSecondaryIndex({
//         indexName: 'profKey-lastMessageAt',
//         partitionKey: { name: 'profKey', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.NUMBER },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 6. DentiPal-Feedback
//       const feedbackTable = new dynamodb.Table(this, 'FeedbackTable', {
//         tableName: 'DentiPal-V5-Feedback',
//         partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 7. DentiPal-JobApplications (Used in REST)
//       const jobApplicationsTable = new dynamodb.Table(this, 'JobApplicationsTable', {
//         tableName: 'DentiPal-V5-JobApplications',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       jobApplicationsTable.addGlobalSecondaryIndex({
//         indexName: 'applicationId-index',
//         partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobApplicationsTable.addGlobalSecondaryIndex({
//         indexName: 'clinicId-index',
//         partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobApplicationsTable.addGlobalSecondaryIndex({
//         indexName: 'clinicId-jobId-index',
//         partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       // Renamed one of the duplicate JobIdIndex definitions
//       jobApplicationsTable.addGlobalSecondaryIndex({
//         indexName: 'JobIdIndex-1',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobApplicationsTable.addGlobalSecondaryIndex({
//         indexName: 'professionalUserSub-index',
//         partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 8. DentiPal-JobInvitations
//       const jobInvitationsTable = new dynamodb.Table(this, 'JobInvitationsTable', {
//         tableName: 'DentiPal-V5-JobInvitations',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       jobInvitationsTable.addGlobalSecondaryIndex({
//         indexName: 'invitationId-index',
//         partitionKey: { name: 'invitationId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobInvitationsTable.addGlobalSecondaryIndex({
//         indexName: 'ProfessionalIndex',
//         partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 9. DentiPal-JobNegotiations
//       const jobNegotiationsTable = new dynamodb.Table(this, 'JobNegotiationsTable', {
//         tableName: 'DentiPal-V5-JobNegotiations',
//         partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'negotiationId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       jobNegotiationsTable.addGlobalSecondaryIndex({
//         indexName: 'index', // Standard index name
//         partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobNegotiationsTable.addGlobalSecondaryIndex({
//         indexName: 'GSI1',
//         partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.INCLUDE,
//         nonKeyAttributes: ['negotiationId', 'clinicId', 'jobId', 'professionalUserSub', 'status', 'lastOfferPay', 'lastOfferFrom', 'updatedAt']
//       });
//       jobNegotiationsTable.addGlobalSecondaryIndex({
//         indexName: 'JobIndex',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 10. DentiPal-JobPostings
//       const jobPostingsTable = new dynamodb.Table(this, 'JobPostingsTable', {
//         tableName: 'DentiPal-V5-JobPostings',
//         partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       jobPostingsTable.addGlobalSecondaryIndex({
//         indexName: 'ClinicIdIndex',
//         partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobPostingsTable.addGlobalSecondaryIndex({
//         indexName: 'DateIndex',
//         partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       // Renamed one of the duplicate JobIdIndex definitions
//       jobPostingsTable.addGlobalSecondaryIndex({
//         indexName: 'jobId-index-1',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       jobPostingsTable.addGlobalSecondaryIndex({
//         indexName: 'JobIdIndex-2',
//         partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 11. DentiPal-Messages (Used by WebSocket Handler)
//       const messagesTable = new dynamodb.Table(this, 'MessagesTable', {
//         tableName: 'DentiPal-V5-Messages',
//         partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING }, // Corrected to messageId per your handler code
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       messagesTable.addGlobalSecondaryIndex({
//         indexName: 'ConversationIdIndex',
//         partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 12. DentiPal-Notifications
//       const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
//         tableName: 'DentiPal-V5-Notifications',
//         partitionKey: { name: 'recipientUserSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 13. DentiPal-OTPVerification
//       const otpVerificationTable = new dynamodb.Table(this, 'OTPVerificationTable', {
//         tableName: 'DentiPal-V5-OTPVerification',
//         partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 14. DentiPal-ProfessionalProfiles
//       const professionalProfilesTable = new dynamodb.Table(this, 'ProfessionalProfilesTable', {
//         tableName: 'DentiPal-V5-ProfessionalProfiles',
//         partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 15. DentiPal-Referrals
//       const referralsTable = new dynamodb.Table(this, 'ReferralsTable', {
//         tableName: 'DentiPal-V5-Referrals',
//         partitionKey: { name: 'referralId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });
//       referralsTable.addGlobalSecondaryIndex({
//         indexName: 'ReferredUserSubIndex',
//         partitionKey: { name: 'referredUserSub', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });
//       referralsTable.addGlobalSecondaryIndex({
//         indexName: 'ReferrerIndex',
//         partitionKey: { name: 'referrerUserSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'sentAt', type: dynamodb.AttributeType.STRING },
//         projectionType: dynamodb.ProjectionType.ALL,
//       });

//       // 16. DentiPal-UserAddresses
//       const userAddressesTable = new dynamodb.Table(this, 'UserAddressesTable', {
//         tableName: 'DentiPal-V5-UserAddresses',
//         partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });

//       // 17. DentiPal-UserClinicAssignments
//       const userClinicAssignmentsTable = new dynamodb.Table(this, 'UserClinicAssignmentsTable', {
//         tableName: 'DentiPal-V5-UserClinicAssignments',
//         partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
//         sortKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
//         billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
//         removalPolicy: cdk.RemovalPolicy.DESTROY,
//       });


//     // Collect all tables for the main REST handler
//     const allTables = [
//       clinicProfilesTable, clinicFavoritesTable, clinicsTable, connectionsTable,
//       conversationsTable, feedbackTable, jobApplicationsTable, jobInvitationsTable,
//       jobNegotiationsTable, jobPostingsTable, messagesTable, notificationsTable,
//       otpVerificationTable, professionalProfilesTable, referralsTable, userAddressesTable,
//       userClinicAssignmentsTable
//     ];

//     // ========================================================================
//     // S3 Buckets for file storage (profile images, certificates, video resumes)
//     // ========================================================================
//     // Buckets are created without explicit physical names so CDK will generate
//     // unique names. Use RemovalPolicy.RETAIN to avoid accidental data loss.
//     const profileImagesBucket = new s3.Bucket(this, 'ProfileImagesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     const certificatesBucket = new s3.Bucket(this, 'CertificatesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     const videoResumesBucket = new s3.Bucket(this, 'VideoResumesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     // Additional buckets requested: professional resumes and driving licenses,
//     // and a dedicated bucket for professional licenses (mapped to CERTIFICATES_BUCKET)
//     const professionalResumesBucket = new s3.Bucket(this, 'ProfessionalResumesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     const drivingLicensesBucket = new s3.Bucket(this, 'DrivingLicensesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     const professionalLicensesBucket = new s3.Bucket(this, 'ProfessionalLicensesBucket', {
//       removalPolicy: cdk.RemovalPolicy.RETAIN,
//       encryption: s3.BucketEncryption.S3_MANAGED,
//       blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
//     });

//     // Tables used specifically by the WebSocket handler
//     const chatTables = [
//         connectionsTable, 
//         conversationsTable, 
//         messagesTable, 
//         clinicsTable // Implicitly used by getClinicDisplayByKey, though primarily via connections/conversations
//     ];

//     // ========================================================================
//     // 3. REST API Lambda Function (Monolith)
//     // ========================================================================

//     const lambdaFunction = new lambda.Function(this, 'ClinicManagementFunction', {
//       functionName: 'DentiPal-Backend-Monolith',
//       runtime: lambda.Runtime.NODEJS_18_X,
//       handler: 'dist/index.handler',
//       code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
//       environment: {
//         REGION: this.region,
//         CLIENT_ID: client.userPoolClientId,
//         USER_POOL_ID: userPool.userPoolId,
//         SES_FROM: 'sreevidya.alluri@gmail.com', // Updated per your env variables
//         SES_REGION: this.region,
//         SES_TO: 'shashitest2004@gmail.com',     // Updated per your env variables
//         SMS_TOPIC_ARN: `arn:aws:sns:${this.region}:${this.account}:DentiPal-SMS-Notifications`, // Dynamic construction
//         FRONTEND_ORIGIN: 'http://localhost:5173',

//         // Table Name Mappings
//         CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
//         CLINIC_FAVORITES_TABLE: clinicFavoritesTable.tableName,
//         CLINICS_TABLE: clinicsTable.tableName,
//         CONNECTIONS_TABLE: connectionsTable.tableName,
//         CONVERSATIONS_TABLE: conversationsTable.tableName,
//         FEEDBACK_TABLE: feedbackTable.tableName,
//         JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
//         JOB_INVITATIONS_TABLE: jobInvitationsTable.tableName,
//         JOB_NEGOTIATIONS_TABLE: jobNegotiationsTable.tableName,
//         JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
//         MESSAGES_TABLE: messagesTable.tableName,
//         NOTIFICATIONS_TABLE: notificationsTable.tableName,
//         OTP_VERIFICATION_TABLE: otpVerificationTable.tableName,
//         PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName,
//         REFERRALS_TABLE: referralsTable.tableName,
//         USER_ADDRESSES_TABLE: userAddressesTable.tableName,
//         USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,

//         // Stats/Alias mappings for code compatibility
//         CLINIC_JOBS_POSTED_TABLE: jobPostingsTable.tableName, 
//         CLINICS_JOBS_COMPLETED_TABLE: jobApplicationsTable.tableName, 
//         // S3 bucket names for file storage
//         PROFILE_IMAGES_BUCKET: profileImagesBucket.bucketName,
//         CERTIFICATES_BUCKET: professionalLicensesBucket.bucketName, // keep existing "certificate" mapping
//         VIDEO_RESUMES_BUCKET: videoResumesBucket.bucketName,
//         PROFESSIONAL_RESUMES_BUCKET: professionalResumesBucket.bucketName,
//         DRIVING_LICENSES_BUCKET: drivingLicensesBucket.bucketName,
//         PROFESSIONAL_LICENSES_BUCKET: professionalLicensesBucket.bucketName,
//       },
//       timeout: cdk.Duration.seconds(60),
//       memorySize: 256,
//     });

//     // Grant the Lambda access to the S3 buckets and expose bucket names as env vars
//     // (env vars need to be added to the function at creation; we update below)

//     // ========================================================================
//     // 4. REST IAM Role Permissions
//     // ========================================================================

//     // DynamoDB Permissions (Granting Full Access for CRUD operations)
//     allTables.forEach(table => {
//       table.grantReadWriteData(lambdaFunction);
//     });

//     // Cognito Permissions
//     lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
//       actions: [
//         'cognito-idp:SignUp',
//         'cognito-idp:ConfirmSignUp',
//         'cognito-idp:AdminAddUserToGroup',
//         'cognito-idp:AdminGetUser',
//         'cognito-idp:AdminCreateUser',
//         'cognito-idp:AdminSetUserPassword',
//         'cognito-idp:AdminUpdateUserAttributes',
//         'cognito-idp:AdminDeleteUser',
//         'cognito-idp:DeleteUser',
//         'cognito-idp:AdminRemoveUserFromGroup',
//         'cognito-idp:ListUsers',
//         'cognito-idp:AdminListGroupsForUser'
//       ],
//       resources: [userPool.userPoolArn],
//     }));

//     // SES Permissions (Sending Emails)
//     lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
//       actions: ['ses:SendEmail', 'ses:SendRawEmail'],
//       resources: ['*'], 
//     }));

//     // SNS Permissions (Sending SMS)
//     lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
//       actions: ['sns:Publish'],
//       resources: ['*'],
//     }));

//     // EventBridge Permissions
//     lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
//       actions: ['events:PutEvents'],
//       resources: ['*'],
//     }));

//     // Grant Lambda read/write access to the file storage buckets
//     profileImagesBucket.grantReadWrite(lambdaFunction);
//     certificatesBucket.grantReadWrite(lambdaFunction);
//     videoResumesBucket.grantReadWrite(lambdaFunction);
//     professionalResumesBucket.grantReadWrite(lambdaFunction);
//     drivingLicensesBucket.grantReadWrite(lambdaFunction);
//     professionalLicensesBucket.grantReadWrite(lambdaFunction);

//     // ========================================================================
//     // 5. REST API Gateway
//     // ========================================================================

//     const api = new apigateway.RestApi(this, 'DentiPalApi', {
//       restApiName: 'DentiPal API',
//       description: 'Backend API for DentiPal',
//       deployOptions: { 
//           stageName: 'prod',
//           tracingEnabled: true,
//       },
//       defaultCorsPreflightOptions: {
//         allowOrigins: apigateway.Cors.ALL_ORIGINS,
//         allowMethods: apigateway.Cors.ALL_METHODS,
//         allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
//       },
//       binaryMediaTypes: ['multipart/form-data'],
//     });

//     // Note: Authorizer removed from standalone creation
//     // as per your original design relying on Lambda logic.

//     // --- Monolith Proxy Resource ---
//     // Catch-all route to route everything to the Lambda
//     api.root.addProxy({
//       defaultIntegration: new apigateway.LambdaIntegration(lambdaFunction),
//       defaultMethodOptions: {
//         authorizationType: apigateway.AuthorizationType.NONE, 
//       }
//     });


//     // ========================================================================
//     // 6. WebSocket API & Handler (New Chat Module)
//     // ========================================================================

//     const webSocketChatHandler = new lambda.Function(this, 'WebSocketChatHandler', {
//         functionName: 'DentiPal-Chat-WebSocket',
//         runtime: lambda.Runtime.NODEJS_18_X,
//         handler: 'dist/websocketHandler.handler', // Assumes bundling puts it in 'dist'
//         code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
//         environment: {
//             REGION: this.region,
//             USER_POOL_ID: userPool.userPoolId,
//             MESSAGES_TABLE: messagesTable.tableName, // DentiPal-Messages
//             CONNS_TABLE: connectionsTable.tableName,   // DentiPal-Connections
//             CONVOS_TABLE: conversationsTable.tableName, // DentiPal-Conversations
//         },
//         timeout: cdk.Duration.seconds(30),
//         memorySize: 256,
//     });

//     // --- WebSocket IAM Role Permissions ---

//     // 1. DynamoDB Permissions for Chat Tables
//     chatTables.forEach(table => {
//         table.grantReadWriteData(webSocketChatHandler);
//     });

//     // 2. Cognito Permissions (AdminGetUser for display name lookup)
//     webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
//         actions: ['cognito-idp:AdminGetUser'],
//         resources: [userPool.userPoolArn],
//     }));

//     // 3. API Gateway Management API (To send messages back to connections)
//     // This policy allows the handler to send data to any connection within the API
//     webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
//         actions: ['execute-api:ManageConnections'],
//         resources: [cdk.Arn.format({
//             service: 'execute-api',
//             resource: '*', // '*' scope for resource is standard for this action
//             resourceName: '*'
//         }, this)],
//     }));


//     // --- WebSocket API Gateway v2 Setup ---

//     const webSocketApi = new apigwv2.WebSocketApi(this, 'DentiPalChatApi', {
//         apiName: 'DentiPal-Chat-API',
//         connectRouteOptions: {
//             integration: new apigwv2integrations.WebSocketLambdaIntegration('ConnectIntegration', webSocketChatHandler),
//         },
//         disconnectRouteOptions: {
//             integration: new apigwv2integrations.WebSocketLambdaIntegration('DisconnectIntegration', webSocketChatHandler),
//         },
//         defaultRouteOptions: {
//             integration: new apigwv2integrations.WebSocketLambdaIntegration('DefaultIntegration', webSocketChatHandler),
//         },
//     });

//     // The $default route handles custom actions like sendMessage, getHistory, etc., 
//     // based on the 'action' field in the message body, as seen in your handler code.
//     // The handler also explicitly defines these actions within its logic.

//     new apigwv2.WebSocketStage(this, 'DentiPalChatStage', {
//         webSocketApi,
//         stageName: 'prod', // Match your REST API stage name
//         autoDeploy: true,
//     });

//     // ========================================================================
//     // 7. Outputs
//     // ========================================================================
//     new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
//     new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
//     new cdk.CfnOutput(this, 'RestApiEndpoint', { value: api.url });
//     new cdk.CfnOutput(this, 'WebSocketEndpoint', { value: webSocketApi.apiEndpoint });

//     // S3 bucket outputs
//     new cdk.CfnOutput(this, 'ProfileImagesBucketName', { value: profileImagesBucket.bucketName });
//     new cdk.CfnOutput(this, 'ProfessionalResumesBucketName', { value: professionalResumesBucket.bucketName });
//     new cdk.CfnOutput(this, 'VideoResumesBucketName', { value: videoResumesBucket.bucketName });
//     new cdk.CfnOutput(this, 'DrivingLicensesBucketName', { value: drivingLicensesBucket.bucketName });
//     new cdk.CfnOutput(this, 'ProfessionalLicensesBucketName', { value: professionalLicensesBucket.bucketName });
//   }
// }
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from '@aws-cdk/aws-apigatewayv2-alpha';
import * as apigwv2integrations from '@aws-cdk/aws-apigatewayv2-integrations-alpha';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as location from 'aws-cdk-lib/aws-location';
import * as eventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as path from 'path';
import { CHATBOT_EXPORTS } from './chatbot-stack';

export class DentiPalCDKStack extends cdk.Stack {
    // ─── Public refs exposed to DentiPalChatbotStack ─────────────────
    // The chatbot stack receives these as constructor props (assembled
    // in bin/denti_pal_cdk.ts) and mutates the chatMessage / monolith
    // Lambdas + grants IAM on shared business tables.
    public userPool!: cognito.UserPool;
    public userPoolClientId!: string;
    public lambdaFunction!: lambda.Function;
    public chatMessageHandler!: lambda.Function;
    public chatMessagesTable!: dynamodb.Table;
    public chatConnectionsTable!: dynamodb.Table;
    public connectionsTable!: dynamodb.Table;
    public chatMemoryId!: string;
    public jobPostingsTable!: dynamodb.Table;
    public jobApplicationsTable!: dynamodb.Table;
    public jobInvitationsTable!: dynamodb.Table;
    public jobNegotiationsTable!: dynamodb.Table;
    public clinicProfilesTable!: dynamodb.Table;
    public clinicsTable!: dynamodb.Table;
    public clinicFavoritesTable!: dynamodb.Table;
    public userClinicAssignmentsTable!: dynamodb.Table;
    public professionalProfilesTable!: dynamodb.Table;
    public userAddressesTable!: dynamodb.Table;
    public notificationPreferencesTable!: dynamodb.Table;
    public feedbackTable!: dynamodb.Table;
    public referralsTable!: dynamodb.Table;
    public jobPromotionsTable!: dynamodb.Table;

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ========================================================================
        // 1. Cognito User Pool
        // ========================================================================
        // Branded OTP verification email — mirrors the visual language of
        // lambda/src/handlers/admin/onboarding/inviteEmail.ts. Cognito
        // substitutes `{####}` with the 6-digit OTP at send time.
        //
        // OTP expiry: Cognito's self-signup confirmation code is valid for
        // 24 hours after delivery. After that, the user must request a new
        // one from the verification screen. The TTL itself isn't tuneable
        // from the UserPool construct, so we hardcode "24 hours" in the copy.
        const SIGNUP_OTP_EMAIL_SUBJECT = "Verify your DentiPal account";
        const SIGNUP_OTP_EMAIL_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verify your DentiPal account</title>
</head>
<body style="margin: 0; padding: 0; background: #f5f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1d1d1f;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f5f5f7; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 480px; background: #ffffff; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
          <!-- Header: solid black bar with white DentiPal wordmark, centered -->
          <tr>
            <td align="center" style="background: #1d1d1f; padding: 22px 32px; text-align: center;">
              <div style="font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: #ffffff;">DentiPal</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 28px 32px 8px;">
              <h1 style="margin: 0 0 6px; font-size: 22px; line-height: 1.25; font-weight: 600; color: #1d1d1f; letter-spacing: -0.02em;">
                Confirm your email
              </h1>
              <p style="margin: 0; color: #424245; line-height: 1.55; font-size: 15px;">
                Use the code below to finish creating your account.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 18px 32px 6px;">
              <div style="font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 30px; font-weight: 600; color: #1d1d1f; background: #f5f5f7; border: 1px solid rgba(0,0,0,0.08); border-radius: 12px; padding: 14px 22px; display: inline-block; letter-spacing: 0.32em;">{####}</div>
              <div style="margin-top: 10px; font-size: 12px; color: #6e6e73;">
                This code expires in <strong style="color: #1d1d1f; font-weight: 600;">24 hours</strong>.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding: 12px 32px 24px;">
              <p style="margin: 0; font-size: 12px; color: #86868b; line-height: 1.55; text-align: center;">
                Never share this code. If this wasn't you, ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer: solid black bar with white text, centered -->
          <tr>
            <td align="center" style="background: #1d1d1f; padding: 18px 32px; text-align: center;">
              <div style="font-size: 13px; color: #ffffff; font-weight: 600; letter-spacing: -0.01em;">DentiPal</div>
              <div style="margin-top: 4px; font-size: 11px; color: rgba(255,255,255,0.72);">
                <a href="https://dentipal.com" style="color: rgba(255,255,255,0.72); text-decoration: none;">dentipal.com</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
        const SIGNUP_OTP_SMS_MESSAGE =
            "Your DentiPal verification code is {####}. Expires in 24 hours. Never share it.";

        const userPool = new cognito.UserPool(this, 'ClinicUserPoolV5', {
            selfSignUpEnabled: true,
            autoVerify: { email: true },
            userVerification: {
                emailSubject: SIGNUP_OTP_EMAIL_SUBJECT,
                emailBody: SIGNUP_OTP_EMAIL_BODY,
                emailStyle: cognito.VerificationEmailStyle.CODE,
                smsMessage: SIGNUP_OTP_SMS_MESSAGE,
            },
            standardAttributes: {
                givenName: { required: true, mutable: true },
                familyName: { required: true, mutable: true },
                phoneNumber: { required: true, mutable: true },
                email: { required: true, mutable: true },
                address: { required: true, mutable: true },
            },
            signInAliases: { email: true },
            passwordPolicy: {
                minLength: 8,
                requireDigits: true,
                requireLowercase: true,
                requireUppercase: true,
                requireSymbols: true,
            },
            removalPolicy: cdk.RemovalPolicy.DESTROY, // Change to RETAIN for prod
        });

        // Pre sign-up Lambda trigger – auto-fills address & phone_number for Google sign-ups
        const preSignUpFn = new lambda.Function(this, 'PreSignUpTrigger', {
            functionName: 'DentiPal-PreSignUp',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/preSignUp.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
        });

        userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, preSignUpFn);

        // Custom Auth Lambda triggers — for Google login without changing user passwords
        const lambdaCode = lambda.Code.fromAsset(path.join(__dirname, '../lambda'));

        const defineAuthChallengeFn = new lambda.Function(this, 'DefineAuthChallenge', {
            functionName: 'DentiPal-DefineAuthChallenge',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/defineAuthChallenge.handler',
            code: lambdaCode,
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
        });

        const createAuthChallengeFn = new lambda.Function(this, 'CreateAuthChallenge', {
            functionName: 'DentiPal-CreateAuthChallenge',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/createAuthChallenge.handler',
            code: lambdaCode,
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
        });

        const verifyAuthChallengeFn = new lambda.Function(this, 'VerifyAuthChallenge', {
            functionName: 'DentiPal-VerifyAuthChallenge',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/verifyAuthChallenge.handler',
            code: lambdaCode,
            timeout: cdk.Duration.seconds(10),
            memorySize: 128,
        });

        userPool.addTrigger(cognito.UserPoolOperation.DEFINE_AUTH_CHALLENGE, defineAuthChallengeFn);
        userPool.addTrigger(cognito.UserPoolOperation.CREATE_AUTH_CHALLENGE, createAuthChallengeFn);
        userPool.addTrigger(cognito.UserPoolOperation.VERIFY_AUTH_CHALLENGE_RESPONSE, verifyAuthChallengeFn);

        const client = userPool.addClient('ClinicAppClientV5', {
            authFlows: { userPassword: true, userSrp: true, adminUserPassword: true, custom: true },
            preventUserExistenceErrors: true,
        });
        this.userPoolClientId = client.userPoolClientId;

        const groups = [
            'Root',
            'ClinicAdmin', // Simplified group names for use in CfnUserPoolGroup
            'ClinicManager',
            'ClinicViewer',
            'AssociateDentist',
            'DentalAssistant',
            'DualRoleFrontDA', // Mapping 'Front Desk/DA'
            'Dental Hygienist', // Mapping 'Hygienist'
        ];

        // Note: The CfnUserPoolGroup names were simplified for the loop to avoid special chars
        // Cognito group names cannot contain spaces - use underscores or camelCase
        const cognitoGroups = [
            'Root',
            'ClinicAdmin',
            'ClinicManager',
            'ClinicViewer',
            'AssociateDentist',
            'DentalAssistant',
            'ExpandedFunctionsDA',
            'DualRoleFrontDA',
            'DentalHygienist',
            'PatientCoordinatorFront',
            'TreatmentCoordinatorFront',
            'FrontDesk',
            'Dentist',
            'Hygienist',
            'DHComboRole',
            'BillingCoordinator',
            'InsuranceVerification',
            'PaymentPosting',
            'ClaimsSending',
            'ClaimsResolution',
            'HIPAATrainee',
            'OSHATrainee',
            'Accounting',
            // Internal team groups — back-office users (admin portal at /admin).
            // Disjoint from clinic/professional groups; users in these groups
            // never appear in clinic associated-users lists.
            'Admin',
            'Sales',
            'Marketing',
            'HR',
        ];

        cognitoGroups.forEach(group => {
            new cognito.CfnUserPoolGroup(this, `Group${group.replace(/[\s/]/g, '')}`, {
                userPoolId: userPool.userPoolId,
                groupName: group,
            });
        });

        // ========================================================================
        // 2. DynamoDB Tables & GSIs
        // ========================================================================

        // 1. DentiPal-Clinic-Profiles
        const clinicProfilesTable = new dynamodb.Table(this, 'ClinicProfilesTable', {
            tableName: 'DentiPal-V5-Clinic-Profiles',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // Stream feeds the cascadeClinicDataUpdate Lambda — keeps denormalized
            // clinic profile fields on JobPostings in sync after profile edits.
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
        });
        clinicProfilesTable.addGlobalSecondaryIndex({
            indexName: 'userSub-index',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 2. DentiPal-ClinicFavorites
        const clinicFavoritesTable = new dynamodb.Table(this, 'ClinicFavoritesTable', {
            tableName: 'DentiPal-V5-ClinicFavorites',
            partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 3. DentiPal-Clinics
        const clinicsTable = new dynamodb.Table(this, 'ClinicsTable', {
            tableName: 'DentiPal-V5-Clinics',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            // Stream feeds the cascadeClinicDataUpdate Lambda — keeps denormalized
            // clinic address fields on JobPostings in sync after address edits,
            // and runs the hard-cascade purge when TTL deletes a soft-deleted row.
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
            // Soft-delete uses `ttl` (unix epoch seconds, +30 days at delete time).
            // DynamoDB removes the row at TTL, which emits a REMOVE stream event
            // that the cascade Lambda turns into a full purge of related data.
            timeToLiveAttribute: 'ttl',
        });

        // Snapshots of clinics that have been soft-deleted. Lives forever —
        // used by the professional-side fallback UI to render "Clinic no
        // longer available" with the last-known name/logo even after the
        // 30-day TTL physically removes the Clinics row.
        const deletedClinicSnapshotsTable = new dynamodb.Table(this, 'DeletedClinicSnapshotsTable', {
            tableName: 'DentiPal-V5-DeletedClinicSnapshots',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // Backup table for the "Delete clinic account" flow. Stores a single
        // frozen snapshot of the owner's identity, all their clinics, profiles,
        // members, ratings, and an account-summary rollup at delete time.
        // Composite key lets the same email/owner re-create an account later
        // and still delete it again without overwriting the prior backup row.
        // RETAIN policy so this table survives even if the stack is destroyed.
        const clinicAccountBackupTable = new dynamodb.Table(this, 'ClinicAccountBackupTable', {
            tableName: 'DentiPal-V5-ClinicAccountBackup',
            partitionKey: { name: 'ownerSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'deletedAt', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // Audit log for every clinic restore action — captures who, when, why,
        // and against whom (the original deleter). Append-only, retained
        // forever so a restore can never be quietly reversed without trace.
        // Keyed by (clinicId PK, restoredAt SK) so a single clinic can be
        // restored more than once over its lifetime and we keep every event.
        const clinicRestoreAuditTable = new dynamodb.Table(this, 'ClinicRestoreAuditTable', {
            tableName: 'DentiPal-V5-ClinicRestoreAudit',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'restoredAt', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });
        clinicsTable.addGlobalSecondaryIndex({
            indexName: 'CreatedByIndex',
            partitionKey: { name: 'createdBy', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 4. DentiPal-Connections (Used by WebSocket Handler)
        const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
            tableName: 'DentiPal-V5-Connections',
            partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        connectionsTable.addGlobalSecondaryIndex({
            indexName: 'connectionId-index',
            partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 4b. DentiPal-V5-ChatConnections (Used by Bedrock AgentCore chatbot)
        //
        // Separate from the user-to-user Connections table on purpose: different
        // TTL (15 min vs 24 h), different access patterns (per-session slot
        // buffer + pending preview), and isolating the two prevents a regression
        // in either feature from corrupting the other.
        //
        // PK: userSub, SK: connectionId. Reverse lookup by connectionId only is
        // served by the connectionId-index GSI (used by chatMessage when it
        // bootstraps a session for a connection whose userSub it hasn't seen
        // yet, and by future $disconnect cleanup).
        const chatConnectionsTable = new dynamodb.Table(this, 'ChatConnectionsTable', {
            tableName: 'DentiPal-V5-ChatConnections',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            timeToLiveAttribute: 'ttl',
        });
        chatConnectionsTable.addGlobalSecondaryIndex({
            indexName: 'connectionId-index',
            partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 4b. DentiPal-ChatMessages — persistent transcript log for the
        // user-facing chat history feature (single continuous thread per user).
        // Separate from AgentCore Memory (which holds compressed summaries for
        // the AI) and from ChatConnections (which holds 15-min session state).
        //
        // Layout: HASH=userSub, RANGE=ts (ISO-8601 ms, lexicographic order
        // matches chronological order). Query descending + Limit gives
        // efficient pagination for the "load older messages on scroll up"
        // pattern. One PutItem per chat turn (user + assistant = 2 writes).
        const chatMessagesTable = new dynamodb.Table(this, 'ChatMessagesTable', {
            tableName: 'DentiPal-V5-ChatMessages',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // ----------------------------------------------------------------
        // Chatbot WS-1/2 tables.
        // ----------------------------------------------------------------

        // GSI on ChatMessages: per-conversation transcript reader. Backs the
        // sidebar's "load this conversation's messages" path AND the
        // cascade-delete when a user removes a conversation. Without this
        // index a per-conversation read would scan the whole user's transcript.
        chatMessagesTable.addGlobalSecondaryIndex({
            indexName: 'conversationId-ts-index',
            partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'ts', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 4c, 4d. ChatConversations + PreviewGates tables moved to
        //         DentiPalChatbotStack (lib/chatbot-stack.ts). The GSI on
        //         ChatMessages above stays here because CFN can't add a
        //         GSI to a table from another stack.

        // 5. DentiPal-Conversations (Used by WebSocket Handler)
        const conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
            tableName: 'DentiPal-V5-Conversations',
            partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        conversationsTable.addGlobalSecondaryIndex({
            indexName: 'clinicKey-lastMessageAt',
            partitionKey: { name: 'clinicKey', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        conversationsTable.addGlobalSecondaryIndex({
            indexName: 'profKey-lastMessageAt',
            partitionKey: { name: 'profKey', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'lastMessageAt', type: dynamodb.AttributeType.NUMBER },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 6. DentiPal-Feedback
        const feedbackTable = new dynamodb.Table(this, 'FeedbackTable', {
            tableName: 'DentiPal-V5-Feedback',
            partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Clinic-rates-professional ratings. One row per (professional, clinic, job)
        // — dedup is enforced by the (PK,SK) primary key. SK shape `clinicId#jobId`
        // lets the submit handler use a plain `attribute_not_exists` condition.
        // The submit handler also writes a denormalized `avgRating`/`ratingCount`
        // pair onto the matching ProfessionalProfiles row so reads don't need a
        // second query.
        const professionalRatingsTable = new dynamodb.Table(this, 'ProfessionalRatingsTable', {
            tableName: 'DentiPal-V5-ProfessionalRatings',
            partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'clinicJobKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // "Ratings this clinic has given" — used to drive the ApplicantCard
        // "already rated" state and to list a clinic's history.
        professionalRatingsTable.addGlobalSecondaryIndex({
            indexName: 'clinicId-createdAt-index',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // Professional-rates-clinic ratings (the inverse of professionalRatingsTable).
        // One row per (clinic, professional, job). SK shape `professionalUserSub#jobId`
        // mirrors the dedup approach above. Submit handler denormalizes the
        // avgRating/ratingCount pair onto the matching ClinicProfiles row.
        const clinicRatingsTable = new dynamodb.Table(this, 'ClinicRatingsTable', {
            tableName: 'DentiPal-V5-ClinicRatings',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'professionalJobKey', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // "Ratings this professional has given" — used to dedupe per-pro and to
        // power a "your reviews of clinics" view if surfaced later.
        clinicRatingsTable.addGlobalSecondaryIndex({
            indexName: 'professionalUserSub-createdAt-index',
            partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // Notification preferences (smart-notifications feature).
        // PK: userSub (Cognito sub). One row per user. Defaults are all-true so
        // a missing row = "send everything" — the get/update handlers backfill on read.
        const notificationPreferencesTable = new dynamodb.Table(this, 'NotificationPreferencesTable', {
            tableName: 'DentiPal-V5-NotificationPreferences',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // In-app notifications feed. One row per surfaced event.
        // PK: userSub, SK: notificationId (epoch-prefixed so Query with
        // ScanIndexForward=false returns newest-first without needing a GSI).
        // TTL on `expiresAt` auto-purges rows after ~90 days (set by writer).
        const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
            tableName: 'DentiPal-V5-Notifications',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 7. DentiPal-JobApplications (Used in REST)
        const jobApplicationsTable = new dynamodb.Table(this, 'JobApplicationsTable', {
            tableName: 'DentiPal-V5-JobApplications',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'applicationId-index',
            partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'clinicId-index',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'clinicId-jobId-index',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Renamed one of the duplicate JobIdIndex definitions
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'JobIdIndex-1',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'professionalUserSub-index',
            partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Sparse GSI for the admin no-show review queue. Only rows where the clinic
        // has reported a no-show carry `noShowReviewStatus`, so this index stays small.
        // Sort key `noShowReportedAt` lets the admin UI scan newest-first.
        jobApplicationsTable.addGlobalSecondaryIndex({
            indexName: 'noShowReview-index',
            partitionKey: { name: 'noShowReviewStatus', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'noShowReportedAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 8. DentiPal-JobInvitations
        const jobInvitationsTable = new dynamodb.Table(this, 'JobInvitationsTable', {
            tableName: 'DentiPal-V5-JobInvitations',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        jobInvitationsTable.addGlobalSecondaryIndex({
            indexName: 'invitationId-index',
            partitionKey: { name: 'invitationId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobInvitationsTable.addGlobalSecondaryIndex({
            indexName: 'ProfessionalIndex',
            partitionKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 9. DentiPal-JobNegotiations
        const jobNegotiationsTable = new dynamodb.Table(this, 'JobNegotiationsTable', {
            tableName: 'DentiPal-V5-JobNegotiations',
            partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'negotiationId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        jobNegotiationsTable.addGlobalSecondaryIndex({
            indexName: 'index', // Standard index name
            partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobNegotiationsTable.addGlobalSecondaryIndex({
            indexName: 'GSI1',
            partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.INCLUDE,
            nonKeyAttributes: ['negotiationId', 'clinicId', 'jobId', 'professionalUserSub', 'status', 'lastOfferPay', 'lastOfferFrom', 'updatedAt']
        });
        jobNegotiationsTable.addGlobalSecondaryIndex({
            indexName: 'JobIndex',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 10. DentiPal-JobPostings
        const jobPostingsTable = new dynamodb.Table(this, 'JobPostingsTable', {
            tableName: 'DentiPal-V5-JobPostings',
            partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        jobPostingsTable.addGlobalSecondaryIndex({
            indexName: 'ClinicIdIndex',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        jobPostingsTable.addGlobalSecondaryIndex({
            indexName: 'DateIndex',
            partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // Single GSI keyed on jobId. The previously duplicate `JobIdIndex-2`
        // has been removed — every handler now queries `jobId-index-1`.
        //
        // ⚠ DEPLOY ORDERING: Do NOT deploy this CDK change until the matching
        // code change in `respondToNegotiation.ts` (which switched from
        // `JobIdIndex-2` to `jobId-index-1`) is fully live in production.
        // Recommended: deploy the code change first, wait 24–48 hours for
        // warm Lambda containers to rotate and CloudWatch metrics to confirm
        // zero reads on `JobIdIndex-2`, then deploy this stack change.
        jobPostingsTable.addGlobalSecondaryIndex({
            indexName: 'jobId-index-1',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // GSI for querying open jobs sorted by creation date (used by professional filtered-jobs)
        jobPostingsTable.addGlobalSecondaryIndex({
            indexName: 'status-createdAt-index',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 11. DentiPal-Messages (Used by WebSocket Handler)
        const messagesTable = new dynamodb.Table(this, 'MessagesTable', {
            tableName: 'DentiPal-V5-Messages',
            partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING }, // Corrected to messageId per your handler code
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // NOTE (audit 2026-04-17): `ConversationIdIndex` has the same PK+SK as the base
        // table above (conversationId + messageId) and is never queried — it is pure
        // WCU and storage cost, duplicating every write. It is kept here for now because
        // removing it requires a deployment against a live production table; see the
        // inbox audit report for guidance. When you're ready to drop it, comment out
        // this block and run `cdk deploy`; the GSI will be removed without touching data.
        messagesTable.addGlobalSecondaryIndex({
            indexName: 'ConversationIdIndex',
            partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 12. DentiPal-Notifications  — REMOVED 2026-04-28. Table was unused.
        // 13. DentiPal-OTPVerification — REMOVED 2026-04-28. Table duplicated
        //     Cognito's native OTP/MFA flow and was never read from.
        //
        // ⚠ DEPLOY ORDERING: Do NOT deploy this CDK change until the prior
        // CDK deploy with `removalPolicy: RETAIN` is live. Sequence:
        //   1. First deploy:  flip RETAIN (already shipped).
        //   2. This deploy:   remove from allTables / env vars / construct.
        //                     CloudFormation removes the tables from the stack
        //                     but leaves the physical DynamoDB tables intact.
        //   3. Manual:        delete the physical tables in the AWS Console
        //                     after a 7–30 day grace period.

        // 14. DentiPal-ProfessionalProfiles
        const professionalProfilesTable = new dynamodb.Table(this, 'ProfessionalProfilesTable', {
            tableName: 'DentiPal-V5-ProfessionalProfiles',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 15. DentiPal-Referrals
        const referralsTable = new dynamodb.Table(this, 'ReferralsTable', {
            tableName: 'DentiPal-V5-Referrals',
            partitionKey: { name: 'referralId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        referralsTable.addGlobalSecondaryIndex({
            indexName: 'ReferredUserSubIndex',
            partitionKey: { name: 'referredUserSub', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        referralsTable.addGlobalSecondaryIndex({
            indexName: 'ReferrerIndex',
            partitionKey: { name: 'referrerUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sentAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 16. DentiPal-UserAddresses
        const userAddressesTable = new dynamodb.Table(this, 'UserAddressesTable', {
            tableName: 'DentiPal-V5-UserAddresses',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 17. DentiPal-UserClinicAssignments
        const userClinicAssignmentsTable = new dynamodb.Table(this, 'UserClinicAssignmentsTable', {
            tableName: 'DentiPal-V5-UserClinicAssignments',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 18. DentiPal-JobPromotions (LinkedIn-style job promotion/boosting)
        const jobPromotionsTable = new dynamodb.Table(this, 'JobPromotionsTable', {
            tableName: 'DentiPal-V5-JobPromotions',
            partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'promotionId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        // Legacy GSI — no longer queried by any handler, kept in this deploy so the
        // DynamoDB "one GSI change per update" rule is respected while the new
        // clinicId-keyed index is being added. Remove in a follow-up deploy.
        jobPromotionsTable.addGlobalSecondaryIndex({
            indexName: 'clinicUserSub-index',
            partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // GSI for querying promotions by clinic (my promotions dashboard).
        // Keyed on clinicId so multi-clinic owners see promotions scoped to the
        // currently-selected clinic rather than every clinic they own.
        jobPromotionsTable.addGlobalSecondaryIndex({
            indexName: 'clinicId-createdAt-index',
            partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        // GSI for expiry cron job (find active promotions that have expired)
        jobPromotionsTable.addGlobalSecondaryIndex({
            indexName: 'status-expiresAt-index',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'expiresAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });


        // 19. DentiPal-Leads — internal sales pipeline.
        //     Every internal user sees every lead (no per-user scoping). The GSIs
        //     support pipeline filtering and "leads I imported" lookups; default list
        //     queries fan out by status via status-lastActivityAt-index.
        const leadsTable = new dynamodb.Table(this, 'LeadsTable', {
            tableName: 'DentiPal-V5-Leads',
            partitionKey: { name: 'leadId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        leadsTable.addGlobalSecondaryIndex({
            indexName: 'status-lastActivityAt-index',
            partitionKey: { name: 'status', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'lastActivityAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });
        leadsTable.addGlobalSecondaryIndex({
            indexName: 'createdBy-createdAt-index',
            partitionKey: { name: 'createdBy', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 20. DentiPal-LeadActivity — append-only audit / timeline per lead.
        //     activityId is a sortable ULID-like string so SK ordering = chronological.
        const leadActivityTable = new dynamodb.Table(this, 'LeadActivityTable', {
            tableName: 'DentiPal-V5-LeadActivity',
            partitionKey: { name: 'leadId', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'activityId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        leadActivityTable.addGlobalSecondaryIndex({
            indexName: 'performedBy-createdAt-index',
            partitionKey: { name: 'performedBy', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 21. DentiPal-Bans — admin-issued login bans for professionals and clinics.
        //     Composite key so professional bans (subjectId = userSub) and clinic
        //     bans (subjectId = clinicId) coexist without colliding.
        const bansTable = new dynamodb.Table(this, 'BansTable', {
            tableName: 'DentiPal-V5-Bans',
            partitionKey: { name: 'subjectType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'subjectId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });
        bansTable.addGlobalSecondaryIndex({
            indexName: 'subjectType-bannedAt-index',
            partitionKey: { name: 'subjectType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'bannedAt', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        // 22. DentiPal-PasswordOtp — short-lived OTPs for password-change flows.
        //     PK = userSub, single row per user; overwrites on resend.
        //     expiresAt is a UNIX epoch (s) used as DynamoDB TTL — DDB
        //     auto-deletes expired rows within ~48h, but our handler also
        //     enforces expiry in code so stale OTPs cannot be used.
        const passwordOtpTable = new dynamodb.Table(this, 'PasswordOtpTable', {
            tableName: 'DentiPal-V5-PasswordOtp',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'expiresAt',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // 23. DentiPal-SessionInvalidations — instant-kick denylist.
        //     When a user changes their password (or we otherwise need to
        //     kick all sessions), we write { userSub, invalidatedBefore }.
        //     The auth middleware compares each token's `iat` against
        //     `invalidatedBefore`; tokens issued earlier are rejected.
        //     ttl auto-cleans rows older than the refresh-token lifetime.
        const sessionInvalidationsTable = new dynamodb.Table(this, 'SessionInvalidationsTable', {
            tableName: 'DentiPal-V5-SessionInvalidations',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: 'ttl',
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        // Collect all tables for the main REST handler
        const allTables = [
            clinicProfilesTable, clinicFavoritesTable, clinicsTable, connectionsTable,
            conversationsTable, feedbackTable, jobApplicationsTable, jobInvitationsTable,
            jobNegotiationsTable, jobPostingsTable, messagesTable,
            professionalProfilesTable, professionalRatingsTable, clinicRatingsTable, referralsTable, userAddressesTable,
            userClinicAssignmentsTable, jobPromotionsTable,
            leadsTable, leadActivityTable, bansTable,
            passwordOtpTable, sessionInvalidationsTable,
            notificationPreferencesTable,
            notificationsTable,
            chatMessagesTable,
            // chatConversationsTable moved to DentiPalChatbotStack — that
            // stack grants the monolith Lambda access cross-stack.
            deletedClinicSnapshotsTable,
            clinicAccountBackupTable,
        ];

        // ========================================================================
        // S3 Buckets for file storage (profile images, certificates, video resumes)
        // ========================================================================
        // Buckets are created without explicit physical names so CDK will generate
        // unique names. Use RemovalPolicy.RETAIN to avoid accidental data loss.
        //
        // CORS: the frontend uploads files directly to S3 via presigned POST, so
        // the browser makes a cross-origin request from the frontend origin to
        // `<bucket>.s3.<region>.amazonaws.com`. Without these rules S3 accepts
        // the upload but omits Access-Control-Allow-Origin on the response,
        // which causes `fetch()` to throw "Failed to fetch" in the browser even
        // though the object was stored. Origins must match corsHeaders.ts.
        const BUCKET_CORS: s3.CorsRule[] = [{
            allowedOrigins: [
                "http://localhost:5173",
                "https://main.d3agcvis750ojb.amplifyapp.com",
                "https://dentipal.com",
                "https://www.dentipal.com",
            ],
            allowedMethods: [
                s3.HttpMethods.POST,
                s3.HttpMethods.PUT,
                s3.HttpMethods.GET,
                s3.HttpMethods.HEAD,
            ],
            allowedHeaders: ["*"],
            exposedHeaders: ["ETag", "Location"],
            maxAge: 3000,
        }];

        const profileImagesBucket = new s3.Bucket(this, 'ProfileImagesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        const certificatesBucket = new s3.Bucket(this, 'CertificatesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        const videoResumesBucket = new s3.Bucket(this, 'VideoResumesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        // Additional buckets requested: professional resumes and driving licenses,
        // and a dedicated bucket for professional licenses (mapped to CERTIFICATES_BUCKET)
        const professionalResumesBucket = new s3.Bucket(this, 'ProfessionalResumesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        const drivingLicensesBucket = new s3.Bucket(this, 'DrivingLicensesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        const professionalLicensesBucket = new s3.Bucket(this, 'ProfessionalLicensesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        const clinicOfficeImagesBucket = new s3.Bucket(this, 'ClinicOfficeImagesBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            cors: BUCKET_CORS,
        });

        // Backup bucket for the "Delete clinic account" flow. Holds copies
        // of every media file the owner had at delete time (their profile
        // image + every owned clinic's office images). Private, versioned,
        // SSE-S3 managed encryption. RETAIN so the bucket survives stack
        // destruction — backups are the last-resort safety net.
        // No CORS — backend reads only via API; browser never hits this directly.
        const clinicAccountBackupBucket = new s3.Bucket(this, 'ClinicAccountBackupBucket', {
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true,
            enforceSSL: true,
        });

        // Tables used specifically by the WebSocket handler
        const chatTables = [
            connectionsTable,
            conversationsTable,
            messagesTable,
            clinicsTable // Implicitly used by getClinicDisplayByKey, though primarily via connections/conversations
        ];

        // ========================================================================
        // 3. REST API Lambda Function (Monolith)
        // ========================================================================

        const lambdaFunction = new lambda.Function(this, 'ClinicManagementFunction', {
            functionName: 'DentiPal-Backend-Monolith',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/index.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                CLIENT_ID: client.userPoolClientId,
                USER_POOL_ID: userPool.userPoolId,
                // Must be a verified SES identity in SES_REGION. Currently
                // using a personal gmail because the `dentipal.com` domain
                // isn't set up yet — once it is, swap to `no-reply@dentipal.com`
                // and verify the domain (DKIM + SPF) in SES for better
                // deliverability and DMARC alignment.
                SES_FROM: 'DentiPal Notifications <viswanadhapallivennela19@gmail.com>',
                APP_URL: 'https://dentipal.com',
                NOTIFICATION_PREFERENCES_TABLE: notificationPreferencesTable.tableName,
                NOTIFICATIONS_TABLE: notificationsTable.tableName,
                CHAT_MESSAGES_TABLE: chatMessagesTable.tableName,
                // Sidebar's conversation list + CRUD — read/written by the
                // REST monolith via /chat/conversations* routes.
                CHAT_CONVERSATIONS_TABLE: cdk.Fn.importValue(CHATBOT_EXPORTS.chatConversationsTableName),
                SES_REGION: this.region,
                SES_TO: 'shashitest2004@gmail.com',     // Updated per your env variables
                SMS_TOPIC_ARN: `arn:aws:sns:${this.region}:${this.account}:DentiPal-SMS-Notifications`, // Dynamic construction
                FRONTEND_ORIGIN: 'https://dentipal.com',
                GOOGLE_CLIENT_ID: '186785894030-o8s1bte9egg9s6a4n61a3jrm6039sep1.apps.googleusercontent.com',
                GOOGLE_CLIENT_SECRET: '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',
                // Fallback only — the frontend always sends `redirectUri` in the
                // request body, computed from window.location.origin. This fallback
                // is hit only if something calls /auth/google-login without it.
                GOOGLE_REDIRECT_URI: 'https://dentipal.com/callback',

                // Table Name Mappings
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
                CLINIC_FAVORITES_TABLE: clinicFavoritesTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                DELETED_CLINIC_SNAPSHOTS_TABLE: deletedClinicSnapshotsTable.tableName,
                CONNECTIONS_TABLE: connectionsTable.tableName,
                CONVERSATIONS_TABLE: conversationsTable.tableName,
                FEEDBACK_TABLE: feedbackTable.tableName,
                JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_INVITATIONS_TABLE: jobInvitationsTable.tableName,
                JOB_NEGOTIATIONS_TABLE: jobNegotiationsTable.tableName,
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                MESSAGES_TABLE: messagesTable.tableName,
                PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName,
                PROFESSIONAL_RATINGS_TABLE: professionalRatingsTable.tableName,
                CLINIC_RATINGS_TABLE: clinicRatingsTable.tableName,
                REFERRALS_TABLE: referralsTable.tableName,
                USER_ADDRESSES_TABLE: userAddressesTable.tableName,
                USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
                JOB_PROMOTIONS_TABLE: jobPromotionsTable.tableName,
                LEADS_TABLE: leadsTable.tableName,
                LEAD_ACTIVITY_TABLE: leadActivityTable.tableName,
                BANS_TABLE: bansTable.tableName,
                PASSWORD_OTP_TABLE: passwordOtpTable.tableName,
                SESSION_INVALIDATIONS_TABLE: sessionInvalidationsTable.tableName,

                // Stats/Alias mappings for code compatibility
                CLINIC_JOBS_POSTED_TABLE: jobPostingsTable.tableName,
                CLINICS_JOBS_COMPLETED_TABLE: jobApplicationsTable.tableName,
                // S3 bucket names for file storage
                PROFILE_IMAGES_BUCKET: profileImagesBucket.bucketName,
                CERTIFICATES_BUCKET: professionalLicensesBucket.bucketName, // keep existing "certificate" mapping
                VIDEO_RESUMES_BUCKET: videoResumesBucket.bucketName,
                PROFESSIONAL_RESUMES_BUCKET: professionalResumesBucket.bucketName,
                DRIVING_LICENSES_BUCKET: drivingLicensesBucket.bucketName,
                PROFESSIONAL_LICENSES_BUCKET: professionalLicensesBucket.bucketName,
                CLINIC_OFFICE_IMAGES_BUCKET: clinicOfficeImagesBucket.bucketName,
                CLINIC_ACCOUNT_BACKUP_BUCKET: clinicAccountBackupBucket.bucketName,

                // Ranking V2 feature flags — see getProfessionalFilteredJobs.ts.
                // Toggle these together to roll out the new relevance score
                // (always-on distance + profile-derived role/skills/specialties
                // + clinic-diversity rerank). Default "false" means production
                // continues to run V1 weights even though V2 code is shipped.
                // Once the canary metrics show the predicted wins, PR 6 will
                // delete both paths and these flags.
                RANKING_V2_PROFILE_SIGNALS: "true",
                RANKING_V2_SCORE: "true",
                RANKING_V2_DIVERSITY: "true",
            },
            timeout: cdk.Duration.seconds(60),
            // Lambda CPU scales with memory. The monolith init (imports every handler + AWS SDK v3)
            // was running ~1.1s cold start on 256 MB; 1024 MB typically halves both cold init and warm duration.
            memorySize: 1024,
        });

        // Grant the Lambda access to the S3 buckets and expose bucket names as env vars
        // (env vars need to be added to the function at creation; we update below)

        // ========================================================================
        // 4. REST IAM Role Permissions
        // ========================================================================

        // DynamoDB Permissions (Granting Full Access for CRUD operations)
        allTables.forEach(table => {
            table.grantReadWriteData(lambdaFunction);
        });
        // ChatConversations table — the REST monolith owns sidebar list/CRUD
        // and transcript pagination, so it needs full RW on the base table
        // plus query on the `userSub-lastMessageAt-index` GSI (for sidebar
        // ordering).
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem',
                'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
                'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem',
            ],
            resources: [
                cdk.Fn.importValue(CHATBOT_EXPORTS.chatConversationsTableArn),
                cdk.Fn.join('', [cdk.Fn.importValue(CHATBOT_EXPORTS.chatConversationsTableArn), '/index/*']),
            ],
        }));

        // Cognito Permissions
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'cognito-idp:SignUp',
                'cognito-idp:ConfirmSignUp',
                'cognito-idp:ResendConfirmationCode',
                'cognito-idp:AdminAddUserToGroup',
                'cognito-idp:AdminGetUser',
                'cognito-idp:AdminCreateUser',
                'cognito-idp:AdminSetUserPassword',
                'cognito-idp:AdminUpdateUserAttributes',
                'cognito-idp:AdminDeleteUser',
                'cognito-idp:DeleteUser',
                'cognito-idp:AdminRemoveUserFromGroup',
                'cognito-idp:ListUsers',
                'cognito-idp:ListUsersInGroup',
                'cognito-idp:AdminListGroupsForUser',
                'cognito-idp:AdminInitiateAuth',
                'cognito-idp:AdminRespondToAuthChallenge',
                'cognito-idp:AdminDisableUser',
                'cognito-idp:AdminEnableUser',
                'cognito-idp:AdminUserGlobalSignOut'
            ],
            resources: [userPool.userPoolArn],
        }));

        // SES Permissions (Sending Emails)
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
        }));

        // SNS Permissions (Sending SMS)
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['sns:Publish'],
            resources: ['*'],
        }));

        // EventBridge Permissions
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['events:PutEvents'],
            resources: ['*'],
        }));

        // Grant Lambda read/write access to the file storage buckets
        profileImagesBucket.grantReadWrite(lambdaFunction);
        certificatesBucket.grantReadWrite(lambdaFunction);
        videoResumesBucket.grantReadWrite(lambdaFunction);
        professionalResumesBucket.grantReadWrite(lambdaFunction);
        drivingLicensesBucket.grantReadWrite(lambdaFunction);
        professionalLicensesBucket.grantReadWrite(lambdaFunction);
        clinicOfficeImagesBucket.grantReadWrite(lambdaFunction);
        // Backup flow needs to CopyObject from live buckets → backup bucket,
        // then DeleteObject from live buckets. Read/Write on backup bucket
        // covers the CopyObject target + later GetObject for retrieval.
        clinicAccountBackupBucket.grantReadWrite(lambdaFunction);


        // Additional permission for dynamodb:Scan on JobPostings table
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['dynamodb:Scan'],
            resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/DentiPal-JobPostings`,
            ],
        }));

        // ─── Amazon Location Service: global geocoding Place Index ───
        const placeIndex = new location.CfnPlaceIndex(this, 'DentiPalPlaceIndex', {
            indexName: 'DentiPalGeocoder',
            dataSource: 'Here',
            pricingPlan: 'RequestBasedUsage',
            description: 'Geocoding for DentiPal addresses (jobs, professionals, clinics)',
        });

        // Grant Lambda permission to search the Place Index
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: ['geo:SearchPlaceIndexForText', 'geo:SearchPlaceIndexForPosition'],
            resources: [placeIndex.attrArn],
        }));

        // Expose the index name to Lambda code via env var
        lambdaFunction.addEnvironment('PLACE_INDEX_NAME', 'DentiPalGeocoder');
        // ========================================================================
        // 5. REST API Gateway
        //    - Configuration updated to include CloudWatch Logging Role and Settings
        // ========================================================================

        // The explicit CloudWatch Role creation has been removed because the 
        // 'cloudWatchRole' property only accepts a boolean (true to auto-create the role).
        // The automatic creation ensures the necessary permissions for logging are set up.

        const api = new apigateway.RestApi(this, 'DentiPalApi', {
            restApiName: 'DentiPal API',
            description: 'Backend API for DentiPal',
            // Setting cloudWatchRole to true instructs CDK to automatically create 
            // the necessary IAM role for API Gateway to push logs to CloudWatch.
            cloudWatchRole: true,
            deployOptions: {
                stageName: 'prod',
                tracingEnabled: true,
                // *** CloudWatch Logging Settings Enabled ***
                metricsEnabled: true,
                loggingLevel: apigateway.MethodLoggingLevel.INFO, // Log INFO level messages
                dataTraceEnabled: true, // Log full request/response data (optional, but helpful for debugging)
            },
            defaultCorsPreflightOptions: {
                allowOrigins: [
                    'http://localhost:5173',
                    'https://main.d3agcvis750ojb.amplifyapp.com',
                    'https://dentipal.com',
                    'https://www.dentipal.com',
                ],
                allowMethods: apigateway.Cors.ALL_METHODS,
                allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token', 'X-Requested-With'],
            },
            binaryMediaTypes: ['multipart/form-data'],
        });

        // Note: Authorizer removed from standalone creation
        // as per your original design relying on Lambda logic.

        // --- Monolith Proxy Resource ---
        // Catch-all route to route everything to the Lambda
        api.root.addProxy({
            defaultIntegration: new apigateway.LambdaIntegration(lambdaFunction),
            defaultMethodOptions: {
                authorizationType: apigateway.AuthorizationType.NONE,
            }
        });

        // ========================================================================
        // 5b. Cascade Lambda — keeps denormalized clinic data on JobPostings fresh
        // ========================================================================
        // Pure addition — no existing handler is modified. The Lambda subscribes
        // to DynamoDB Streams from Clinics + Clinic-Profiles. When either is
        // updated, it queries active JobPostings via ClinicIdIndex and updates
        // their snapshotted address / profile fields. Failure is non-fatal —
        // worst case the system continues to behave as it did before this Lambda.
        const cascadeClinicDataFn = new lambda.Function(this, 'CascadeClinicDataUpdate', {
            functionName: 'DentiPal-CascadeClinicDataUpdate',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/cascadeClinicDataUpdate.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            memorySize: 256,
            environment: {
                REGION: this.region,
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
                // Needed by the REMOVE branch (TTL-triggered hard purge of
                // every clinic-scoped table + the office-image S3 prefix).
                JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_INVITATIONS_TABLE: jobInvitationsTable.tableName,
                JOB_NEGOTIATIONS_TABLE: jobNegotiationsTable.tableName,
                USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
                CLINIC_FAVORITES_TABLE: clinicFavoritesTable.tableName,
                FEEDBACK_TABLE: feedbackTable.tableName,
                NOTIFICATIONS_TABLE: notificationsTable.tableName,
                CLINIC_OFFICE_IMAGES_BUCKET: clinicOfficeImagesBucket.bucketName,
            },
            // Hard purge across 8 tables + S3 for a busy clinic can take a while;
            // bump from 60s so the BatchWriteItem retry loop has room.
            timeout: cdk.Duration.minutes(5),
        });

        // Read jobs by ClinicIdIndex; update jobs by primary key.
        jobPostingsTable.grantReadWriteData(cascadeClinicDataFn);
        // Hard-purge grants — read for Query/Scan, write for BatchWriteItem deletes.
        clinicProfilesTable.grantReadWriteData(cascadeClinicDataFn);
        jobApplicationsTable.grantReadWriteData(cascadeClinicDataFn);
        jobInvitationsTable.grantReadWriteData(cascadeClinicDataFn);
        jobNegotiationsTable.grantReadWriteData(cascadeClinicDataFn);
        userClinicAssignmentsTable.grantReadWriteData(cascadeClinicDataFn);
        clinicFavoritesTable.grantReadWriteData(cascadeClinicDataFn);
        feedbackTable.grantReadWriteData(cascadeClinicDataFn);
        notificationsTable.grantReadWriteData(cascadeClinicDataFn);
        clinicOfficeImagesBucket.grantReadWrite(cascadeClinicDataFn);

        // Wire each source table's stream as an event source for the cascade.
        cascadeClinicDataFn.addEventSource(new eventSources.DynamoEventSource(clinicsTable, {
            startingPosition: lambda.StartingPosition.LATEST,
            batchSize: 10,
            retryAttempts: 3,
            bisectBatchOnError: true,
        }));
        cascadeClinicDataFn.addEventSource(new eventSources.DynamoEventSource(clinicProfilesTable, {
            startingPosition: lambda.StartingPosition.LATEST,
            batchSize: 10,
            retryAttempts: 3,
            bisectBatchOnError: true,
        }));


        // ========================================================================
        // 6. WebSocket API & Handler (New Chat Module)
        // ========================================================================

        const webSocketChatHandler = new lambda.Function(this, 'WebSocketChatHandler', {
            functionName: 'DentiPal-Chat-WebSocket',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/websocketHandler.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                USER_POOL_ID: userPool.userPoolId,
                CLIENT_ID: client.userPoolClientId,
                USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
                MESSAGES_TABLE: messagesTable.tableName, // DentiPal-Messages
                CONNS_TABLE: connectionsTable.tableName,   // DentiPal-Connections
                CONVOS_TABLE: conversationsTable.tableName, // DentiPal-Conversations
                CLINICS_TABLE: clinicsTable.tableName,             // DentiPal-Clinics (for clinic name lookup)
                PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName, // for avatar lookup
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,             // for avatar lookup
                PROFILE_IMAGES_BUCKET: profileImagesBucket.bucketName,            // for presigned URLs
                CLINIC_OFFICE_IMAGES_BUCKET: clinicOfficeImagesBucket.bucketName, // for clinic office image presigned URLs
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 512,
        });

        // --- WebSocket IAM Role Permissions ---

        // 1. DynamoDB Permissions for Chat Tables
        chatTables.forEach(table => {
            table.grantReadWriteData(webSocketChatHandler);
        });

        // 1b. Read access on profile tables (for avatar URLs in conversations response)
        professionalProfilesTable.grantReadData(webSocketChatHandler);
        clinicProfilesTable.grantReadData(webSocketChatHandler);

        // 1b². Read access on user-clinic assignments (multi-clinic authorization check)
        userClinicAssignmentsTable.grantReadData(webSocketChatHandler);

        // 1c. S3 read access for presigning profile image URLs
        profileImagesBucket.grantRead(webSocketChatHandler);
        clinicOfficeImagesBucket.grantRead(webSocketChatHandler);

        // 2. Cognito Permissions (AdminGetUser for display name lookup)
        webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser'],
            resources: [userPool.userPoolArn],
        }));

        // 3. API Gateway Management API (To send messages back to connections)
        // PostToConnection / DeleteConnection / GetConnection on the
        // @connections/* path require BOTH `execute-api:ManageConnections`
        // (the documented action) AND `execute-api:Invoke` (what the runtime
        // actually checks against the @connections resource ARN — without it
        // the Lambda gets an AccessDeniedException whose message confusingly
        // names `execute-api:Invoke`, and the client never receives the
        // conversationsResponse → inbox shows skeleton rows forever).
        webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['execute-api:ManageConnections', 'execute-api:Invoke'],
            resources: [cdk.Arn.format({
                service: 'execute-api',
                resource: '*', // '*' scope for resource is standard for this action
                resourceName: '*'
            }, this)],
        }));

        // 4. EventBridge PutEvents — onSendMessage publishes a `message-received`
        // ShiftEvent so event-to-notification turns it into an in-app
        // notification for the recipient professional. Same default-bus path
        // the REST monolith uses; the existing ShiftEventRule fans it out.
        webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['events:PutEvents'],
            resources: ['*'],
        }));


        // --- WebSocket API Gateway v2 Setup ---

        const webSocketApi = new apigwv2.WebSocketApi(this, 'DentiPalChatApi', {
            apiName: 'DentiPal-Chat-API',
            connectRouteOptions: {
                integration: new apigwv2integrations.WebSocketLambdaIntegration('ConnectIntegration', webSocketChatHandler),
            },
            disconnectRouteOptions: {
                integration: new apigwv2integrations.WebSocketLambdaIntegration('DisconnectIntegration', webSocketChatHandler),
            },
            defaultRouteOptions: {
                integration: new apigwv2integrations.WebSocketLambdaIntegration('DefaultIntegration', webSocketChatHandler),
            },
        });

        // The $default route handles custom actions like sendMessage, getHistory, etc., 
        // based on the 'action' field in the message body, as seen in your handler code.
        // The handler also explicitly defines these actions within its logic.

        const webSocketStage = new apigwv2.WebSocketStage(this, 'DentiPalChatStage', {
            webSocketApi,
            stageName: 'prod', // Match your REST API stage name
            autoDeploy: true,
        });

        // --- Custom domain: wss://ws.dentipal.com ---
        const wsDomainCertArn = 'arn:aws:acm:us-east-1:489502444760:certificate/8aff342e-17de-4fda-affc-c5edaa3f490a';

        const wsDomain = new apigwv2.DomainName(this, 'WsCustomDomain', {
            domainName: 'ws.dentipal.com',
            certificate: acm.Certificate.fromCertificateArn(this, 'WsDomainCert', wsDomainCertArn),
        });

        new apigwv2.ApiMapping(this, 'WsApiMapping', {
            api: webSocketApi,
            domainName: wsDomain,
            stage: webSocketStage,
        });

        new cdk.CfnOutput(this, 'WsCustomDomainTarget', {
            value: wsDomain.regionalDomainName,
            description: 'Use this as the value for the ws.dentipal.com CNAME record',
        });


        // --- 6a.3b AgentCore Memory — long-term, cross-session user memory ---
        // Replaces the 15-min Bedrock Agents session memory with persistent
        // per-user memory. AgentCore Memory runs two managed strategies in
        // the background:
        //   - SUMMARIZATION: rolling per-session summaries, scoped per user.
        //   - USER_PREFERENCE: structured extracted preferences, scoped per
        //     user across all sessions.
        // chatMessage Lambda calls CreateEvent on every turn and
        // RetrieveMemoryRecords on session bootstrap to inject prior summary
        // and preferences into the first-turn preamble. Bedrock Agents
        // continues to handle the actual model + tool loop unchanged.
        //
        // MemoryExecutionRoleArn is intentionally omitted — AgentCore uses
        // its service-linked role, which has the right permissions for the
        // built-in strategies' Bedrock model calls. Providing a custom role
        // would override that with whatever we wrote, which is fragile.

        // L2/L1 constructs for AWS::BedrockAgentCore::* are not yet in this
        // CDK version (2.206). Use the generic CfnResource escape hatch — it
        // renders the CFN resource directly, so AgentCore support requires
        // no CDK upgrade. Switch to bedrock.CfnMemory once aws-cdk-lib ships it.
        const chatMemory = new cdk.CfnResource(this, 'DentiPalChatMemory', {
            type: 'AWS::BedrockAgentCore::Memory',
            properties: {
                // Name pattern is ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ — underscores only.
                Name: 'DentiPal_ChatMemory',
                Description: 'Long-term chat memory for DentiPal users (per-user summaries and preferences).',
                // 90 days — long enough for "the agent remembers me a month later"
                // without retaining indefinitely. Bumpable later without recreating.
                EventExpiryDuration: 90,
                MemoryStrategies: [
                    {
                        SummaryMemoryStrategy: {
                            Name: 'sessionSummaries',
                            Description: 'Rolling per-session conversation summary, scoped per actor (Cognito userSub).',
                            // Template form — AgentCore expands {actorId} from the
                            // CreateEvent's actorId field (we pass userSub) and
                            // {sessionId} from the event's sessionId.
                            NamespaceTemplates: ['/summaries/{actorId}/{sessionId}/'],
                        },
                    },
                    {
                        UserPreferenceMemoryStrategy: {
                            Name: 'userPreferences',
                            Description: 'Structured user preferences (preferred shifts, roles, locations, etc.), extracted across all sessions for an actor.',
                            // Per-actor only — preferences merge across sessions,
                            // not silo per-session.
                            NamespaceTemplates: ['/preferences/{actorId}/'],
                        },
                    },
                ],
            },
        });
        const chatMemoryId = chatMemory.getAtt('MemoryId').toString();
        const chatMemoryArn = chatMemory.getAtt('MemoryArn').toString();

        // Wire AgentCore Memory ID + deletion IAM into the monolith REST
        // Lambda so its account-deletion handlers (deleteOwnAccount.ts,
        // deleteUser.ts) can call clearUserMemory and actually delete the
        // user's memory records on account closure. Without this, the
        // clearUserMemory call silently no-ops and we leave conversational
        // artifacts behind (GDPR gap).
        lambdaFunction.addEnvironment('AGENTCORE_MEMORY_ID', chatMemoryId);
        lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'bedrock-agentcore:ListMemoryRecords',
                'bedrock-agentcore:BatchDeleteMemoryRecords',
            ],
            resources: [chatMemoryArn],
        }));


        // --- 6a.4 chatMessage Lambda — handles the new WebSocket route ---
        const chatMessageHandler = new lambda.Function(this, 'ChatMessageHandler', {
            functionName: 'DentiPal-Chat-Message',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/chat/chatMessage.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                USER_POOL_ID: userPool.userPoolId,
                // ChatConnections (new) + Connections (existing, for bootstrap read)
                CHAT_CONNECTIONS_TABLE: chatConnectionsTable.tableName,
                CONNS_TABLE: connectionsTable.tableName,
                // Chatbot stack outputs — runtime ARNs (one per agent role) +
                // the PreviewGates table that the confirm-path verifies tokens
                // against. Resolved at synth time via Fn::ImportValue against
                // DentiPalChatbotStackV5's CfnOutputs (CHATBOT_EXPORTS).
                PREVIEW_GATES_TABLE: cdk.Fn.importValue(CHATBOT_EXPORTS.previewGatesTableName),
                BEDROCK_RUNTIME_PROFESSIONAL_ARN: cdk.Fn.importValue(CHATBOT_EXPORTS.professionalAgentArn),
                BEDROCK_RUNTIME_CLINIC_ARN: cdk.Fn.importValue(CHATBOT_EXPORTS.clinicAgentArn),
                BEDROCK_RUNTIME_PUBLIC_ARN: cdk.Fn.importValue(CHATBOT_EXPORTS.publicAgentArn),
                // AgentCore Memory — long-term per-user memory hydrated by
                // the LangGraph runtime on each invocation. The chat Lambda
                // itself no longer reads it (the legacy Bedrock Agents path
                // is gone); only the runtime container does.
                AGENTCORE_MEMORY_ID: chatMemoryId,
                // User-facing chat history transcript (single continuous
                // thread per user). Written from this Lambda after each turn;
                // read by the monolith via GET /chat/history.
                CHAT_MESSAGES_TABLE: chatMessagesTable.tableName,
                // Tables read/written by the refactored run* functions called from toolExecutor
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_INVITATIONS_TABLE: jobInvitationsTable.tableName,
                JOB_NEGOTIATIONS_TABLE: jobNegotiationsTable.tableName,
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                CLINIC_FAVORITES_TABLE: clinicFavoritesTable.tableName,
                PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName,
                USER_ADDRESSES_TABLE: userAddressesTable.tableName,
                USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
                // Phase 4 tables
                NOTIFICATION_PREFERENCES_TABLE: notificationPreferencesTable.tableName,
                PREFS_TABLE: notificationPreferencesTable.tableName, // legacy alias used by some handlers
                FEEDBACK_TABLE: feedbackTable.tableName,
                REFERRALS_TABLE: referralsTable.tableName,
                // Raw WebSocket API ID — needed because the management API
                // (PostToConnection) does NOT accept the custom domain
                // `ws.dentipal.com`. The Lambda uses this to construct the
                // raw `<api-id>.execute-api.<region>.amazonaws.com` host.
                WEBSOCKET_API_ID: webSocketApi.apiId,
            },
            timeout: cdk.Duration.seconds(60), // Bedrock streaming + multi-loop tool exec
            memorySize: 1024,
        });

        // DynamoDB grants — chatMessage routes through run* functions + the
        // handler adapter and therefore needs the union of every table those
        // handlers touch. Phase 2 expanded the surface: jobs CRUD, applicants,
        // invitations, negotiations, favorites, assignments, profiles.
        chatConnectionsTable.grantReadWriteData(chatMessageHandler);
        connectionsTable.grantReadData(chatMessageHandler);
        jobPostingsTable.grantReadWriteData(chatMessageHandler);
        jobApplicationsTable.grantReadWriteData(chatMessageHandler);
        jobInvitationsTable.grantReadWriteData(chatMessageHandler);
        jobNegotiationsTable.grantReadWriteData(chatMessageHandler);
        clinicProfilesTable.grantReadWriteData(chatMessageHandler);
        clinicsTable.grantReadWriteData(chatMessageHandler);
        clinicFavoritesTable.grantReadWriteData(chatMessageHandler);
        userClinicAssignmentsTable.grantReadWriteData(chatMessageHandler); // upgraded for team management (Phase 4)
        professionalProfilesTable.grantReadWriteData(chatMessageHandler);
        userAddressesTable.grantReadWriteData(chatMessageHandler); // upgraded for update_home_address (Phase 4)
        // getProfessionalFilteredJobs overlays "promoted" jobs on top of search
        // results by Query-ing JobPromotions/status-expiresAt-index. Without
        // this grant the canonical pro search throws AccessDeniedException at
        // /var/task/dist/handlers/getProfessionalFilteredJobs.js:164.
        jobPromotionsTable.grantReadWriteData(chatMessageHandler);
        // Phase 4: notifications, feedback, referrals
        notificationPreferencesTable.grantReadWriteData(chatMessageHandler);
        feedbackTable.grantReadWriteData(chatMessageHandler);
        referralsTable.grantReadWriteData(chatMessageHandler);
        // User-facing chat transcript log (write-only from this Lambda; reads
        // happen on the REST monolith via GET /chat/history). Granted full
        // RW because the same Lambda may also clear a user's thread when
        // they hit "Start fresh" in the future.
        chatMessagesTable.grantReadWriteData(chatMessageHandler);
        // Chatbot stack grants. PreviewGates RW for confirm-path verify; the
        // wildcard ARN suffixes on the runtime ARNs cover ":endpoint/*" /
        // ":session/*" descendants Bedrock attaches to each agent runtime.
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem',
                'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan',
                'dynamodb:BatchWriteItem', 'dynamodb:BatchGetItem',
            ],
            resources: [cdk.Fn.importValue(CHATBOT_EXPORTS.previewGatesTableArn)],
        }));
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['bedrock-agentcore:InvokeAgentRuntime'],
            resources: [
                cdk.Fn.importValue(CHATBOT_EXPORTS.professionalAgentArn),
                cdk.Fn.importValue(CHATBOT_EXPORTS.clinicAgentArn),
                cdk.Fn.importValue(CHATBOT_EXPORTS.publicAgentArn),
                cdk.Fn.join('', [cdk.Fn.importValue(CHATBOT_EXPORTS.professionalAgentArn), '/*']),
                cdk.Fn.join('', [cdk.Fn.importValue(CHATBOT_EXPORTS.clinicAgentArn), '/*']),
                cdk.Fn.join('', [cdk.Fn.importValue(CHATBOT_EXPORTS.publicAgentArn), '/*']),
            ],
        }));

        // Cognito access — AdminGetUser for given_name/family_name (used by
        // refactored handlers like createTemporaryJob), AdminListGroupsForUser
        // for the chatbot's server-side agent-type override (resolves whether
        // the caller is clinic vs professional from groups, source of truth).
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'cognito-idp:AdminGetUser',
                'cognito-idp:AdminListGroupsForUser',
            ],
            resources: [userPool.userPoolArn],
        }));

        // Amazon Location — geocode user home address for `search_jobs_near_me`
        // radius filter. Scoped to the DentiPalGeocoder place-index.
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['geo:SearchPlaceIndexForText'],
            resources: [`arn:aws:geo:${this.region}:${this.account}:place-index/DentiPalGeocoder`],
        }));

        // Bedrock invoke permission — agent ARNs + guardrail + foundation-model
        // (cross-region). Wide enough to avoid 'Access denied' on the runtime
        // path; the agent's own service role still gates model inference.
        // bedrock:InvokeAgent / Guardrail / foundation-model perms are no
        // longer needed on chatMessage Lambda — the legacy Bedrock Agents
        // path was removed. The AgentCore Runtime ARN grants are added
        // separately by runtimeWiring() above. ApplyGuardrail / InvokeModel
        // live on the runtime's role (lib/chat-runtime.ts), not here.

        // AgentCore Memory data-plane access — kept because clearUserMemory
        // (called from the account-deletion path via deleteOwnAccount.ts)
        // lists then batch-deletes a user's records when their account
        // closes. The runtime itself reads/writes via its own role.
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'bedrock-agentcore:CreateEvent',
                'bedrock-agentcore:RetrieveMemoryRecords',
                'bedrock-agentcore:ListMemoryRecords',
                'bedrock-agentcore:DeleteMemoryRecord',
                'bedrock-agentcore:BatchDeleteMemoryRecords',
                'bedrock-agentcore:ListEvents',
                'bedrock-agentcore:DeleteEvent',
            ],
            resources: [chatMemoryArn],
        }));

        // EventBridge PutEvents — handlers like acceptProf / rejectProf /
        // confirmShiftCompletion / etc. publish ShiftEvent so the inbox
        // event-to-message Lambda can write a system message into the
        // applicant's conversation. Without this, in-process invocations from
        // the chatbot fail with AccessDenied on PutEvents and surface as a
        // generic 500 "Failed to accept applicant".
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['events:PutEvents'],
            resources: ['*'],
        }));

        // PostToConnection — push streamed frames back to the client.
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['execute-api:ManageConnections'],
            resources: [cdk.Arn.format({
                service: 'execute-api',
                resource: '*',
                resourceName: '*',
            }, this)],
        }));

        // --- 6a.5 Mount the new `chatMessage` and `confirmAction` routes ---
        // Both routes target the SAME Lambda — the handler branches on
        // frame.action internally. Without an explicit `confirmAction` route,
        // API Gateway falls back to the existing $default handler (the user-
        // to-user inbox lambda), which responds with `{type:"error", error:"..."}`
        // — the widget reads `frame.reason` and renders "Error (undefined)".
        webSocketApi.addRoute('chatMessage', {
            integration: new apigwv2integrations.WebSocketLambdaIntegration(
                'ChatMessageIntegration',
                chatMessageHandler,
            ),
        });
        webSocketApi.addRoute('confirmAction', {
            integration: new apigwv2integrations.WebSocketLambdaIntegration(
                'ConfirmActionIntegration',
                chatMessageHandler,
            ),
        });

        new cdk.CfnOutput(this, 'ChatMessageHandlerName', { value: chatMessageHandler.functionName });
        // Legacy CfnAgent outputs removed — see WS-4 outputs (ProfessionalAgentRuntimeArn etc.) above.

        // 6c. Public agent — REMOVED (was Phase 3 OpenSearch Serverless + KB).
        //     To re-add: restore S3 bucket + OpenSearch collection + KB + Public CfnAgent.
        //     See git history for the full block. Lighter-weight alternative when
        //     re-adding: stuff the FAQ corpus into the agent's instruction text
        //     directly (Haiku 4.5 has 200K context) and skip KB infrastructure.

        // ========================================================================
        // 6b. Event-to-Message Lambda (System messages for inbox)
        //     Triggered by EventBridge when shifts are scheduled, cancelled, etc.
        //     Creates system messages in conversations and pushes via WebSocket.
        // ========================================================================

        const eventToMessageHandler = new lambda.Function(this, 'EventToMessageHandler', {
            functionName: 'DentiPal-event-to-message',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/event-to-message.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                USER_POOL_ID: userPool.userPoolId,
                MESSAGES_TABLE: messagesTable.tableName,
                CONNS_TABLE: connectionsTable.tableName,
                CONVOS_TABLE: conversationsTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                WS_ENDPOINT: `https://${webSocketApi.apiId}.execute-api.${this.region}.amazonaws.com/prod`,
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
        });

        // DynamoDB permissions for chat tables + clinics
        chatTables.forEach(table => {
            table.grantReadWriteData(eventToMessageHandler);
        });

        // Cognito permissions (AdminGetUser for professional name lookup)
        eventToMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser'],
            resources: [userPool.userPoolArn],
        }));

        // WebSocket push permission (PostToConnection)
        eventToMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['execute-api:ManageConnections'],
            resources: [cdk.Arn.format({
                service: 'execute-api',
                resource: '*',
                resourceName: '*'
            }, this)],
        }));

        // EventBridge Rule: route ShiftEvent to event-to-message Lambda
        const shiftEventRule = new events.Rule(this, 'ShiftEventRule', {
            ruleName: 'DentiPal-ShiftEvent-to-Inbox',
            eventPattern: {
                source: ['denti-pal.api'],
                detailType: ['ShiftEvent'],
            },
        });
        shiftEventRule.addTarget(new targets.LambdaFunction(eventToMessageHandler));

        // ========================================================================
        // 6c. Event-to-Email Lambda (smart-notifications feature)
        //     Subscribes to the same EventBridge rule alongside event-to-message.
        //     Looks up the professional's email in Cognito, checks their
        //     notification preferences, renders an email template, and sends via SES.
        //     Clinic-targeted events (shift-applied, invite-accepted) are no-ops here.
        // ========================================================================

        const eventToEmailHandler = new lambda.Function(this, 'EventToEmailHandler', {
            functionName: 'DentiPal-event-to-email',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/event-to-email.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                USER_POOL_ID: userPool.userPoolId,
                NOTIFICATION_PREFERENCES_TABLE: notificationPreferencesTable.tableName,
                // Must be a verified SES identity in SES_REGION. Currently
                // using a personal gmail because the `dentipal.com` domain
                // isn't set up yet — once it is, swap to `no-reply@dentipal.com`
                // and verify the domain (DKIM + SPF) in SES for better
                // deliverability and DMARC alignment.
                SES_FROM: 'DentiPal Notifications <viswanadhapallivennela19@gmail.com>',
                SES_REGION: this.region,
                APP_URL: 'https://dentipal.com',
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
        });

        notificationPreferencesTable.grantReadData(eventToEmailHandler);

        eventToEmailHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser'],
            resources: [userPool.userPoolArn],
        }));

        eventToEmailHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
        }));

        // Fan-out: same EventBridge rule, second target.
        shiftEventRule.addTarget(new targets.LambdaFunction(eventToEmailHandler));

        // ========================================================================
        // 6e. Event-to-Notification Lambda (in-app notification feed)
        //     Third target on the same EventBridge rule. For each event,
        //     writes one row to DentiPal-V5-Notifications so the bell icon
        //     and notifications page can render it. Unlike email, this path
        //     does NOT respect per-category preferences — users mute via the
        //     bell or notification settings, not by dropping rows.
        // ========================================================================

        const eventToNotificationHandler = new lambda.Function(this, 'EventToNotificationHandler', {
            functionName: 'DentiPal-event-to-notification',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/event-to-notification.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                NOTIFICATIONS_TABLE: notificationsTable.tableName,
                // Needed by getClinicRecipientSubs() to fan out clinic-team
                // notifications (one bell entry per team member).
                CLINICS_TABLE: clinicsTable.tableName,
            },
            timeout: cdk.Duration.seconds(30),
            memorySize: 256,
        });

        notificationsTable.grantWriteData(eventToNotificationHandler);
        clinicsTable.grantReadData(eventToNotificationHandler);

        // Third target on the same rule; EventBridge fans out independently
        // to email, chat, and notification consumers.
        shiftEventRule.addTarget(new targets.LambdaFunction(eventToNotificationHandler));

        // ========================================================================
        // 6d. Shift Reminder Cron Lambda (smart-notifications feature)
        //     Fires every 15 minutes. Scans JobApplications for status="scheduled",
        //     joins to JobPostings, computes UTC reminder time from
        //     (date, start_time, timezone), and emails 24h-before / 1h-before
        //     reminders. Idempotency via remindersSent.{h24,h1} flags.
        // ========================================================================

        const sendShiftRemindersHandler = new lambda.Function(this, 'SendShiftRemindersHandler', {
            functionName: 'DentiPal-send-shift-reminders',
            runtime: lambda.Runtime.NODEJS_18_X,
            handler: 'dist/handlers/sendShiftReminders.handler',
            code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
            environment: {
                REGION: this.region,
                USER_POOL_ID: userPool.userPoolId,
                JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                JOB_ID_INDEX: 'jobId-index-1',
                NOTIFICATION_PREFERENCES_TABLE: notificationPreferencesTable.tableName,
                // Must be a verified SES identity in SES_REGION. Currently
                // using a personal gmail because the `dentipal.com` domain
                // isn't set up yet — once it is, swap to `no-reply@dentipal.com`
                // and verify the domain (DKIM + SPF) in SES for better
                // deliverability and DMARC alignment.
                SES_FROM: 'DentiPal Notifications <viswanadhapallivennela19@gmail.com>',
                SES_REGION: this.region,
                APP_URL: 'https://dentipal.com',
            },
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
        });

        jobApplicationsTable.grantReadWriteData(sendShiftRemindersHandler);
        jobPostingsTable.grantReadData(sendShiftRemindersHandler);
        notificationPreferencesTable.grantReadData(sendShiftRemindersHandler);

        sendShiftRemindersHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['cognito-idp:AdminGetUser'],
            resources: [userPool.userPoolArn],
        }));

        sendShiftRemindersHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['ses:SendEmail', 'ses:SendRawEmail'],
            resources: ['*'],
        }));

        const reminderRule = new events.Rule(this, 'ShiftReminderCronRule', {
            ruleName: 'DentiPal-ShiftReminders-Every15Min',
            schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
        });
        reminderRule.addTarget(new targets.LambdaFunction(sendShiftRemindersHandler));

        // ========================================================================
        // 6b. Professional Backup Resources (delete-account only)
        //     DynamoDB table (all field data) + S3 bucket (file copies only).
        //     The delete-account handler runs inside the monolith and writes
        //     a backup snapshot just-in-time before purging the user's data.
        //     Encryption: DynamoDB default + S3-managed AES-256. No KMS.
        // ========================================================================

        // Single backup table: holds every professional's data + nested
        // related rows (addresses, invitations, referrals) per snapshot.
        // PK = userSub, SK = snapshotId (e.g. "2026-05-13T03:00:00Z" for
        // daily backups, "delete-<ts>" for pre-deletion archives).
        const professionalBackupTable = new dynamodb.Table(this, 'ProfessionalBackupTable', {
            tableName: 'DentiPal-V5-ProfessionalBackup',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'snapshotId', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            pointInTimeRecovery: true,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });
        // GSI to list all snapshots of a given type (daily / delete)
        professionalBackupTable.addGlobalSecondaryIndex({
            indexName: 'snapshotType-snapshotId-index',
            partitionKey: { name: 'snapshotType', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'snapshotId', type: dynamodb.AttributeType.STRING },
            projectionType: dynamodb.ProjectionType.ALL,
        });

        const profBackupsBucket = new s3.Bucket(this, 'ProfBackups', {
            bucketName: `dentipal-prof-backups-${this.account}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            enforceSSL: true,
            lifecycleRules: [{
                id: 'archive-and-expire',
                transitions: [
                    { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
                    { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
                ],
                expiration: cdk.Duration.days(730),
                noncurrentVersionExpiration: cdk.Duration.days(90),
            }],
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // The delete-account handler runs inside the existing monolith Lambda
        // (wired via index.ts router as DELETE /professionals/me/account).
        // The monolith already has Cognito AdminDeleteUser, ReadWrite on all
        // source buckets, and ReadWrite on all live tables. We grant it
        // write access to the backup bucket + backup table and expose names.
        profBackupsBucket.grantReadWrite(lambdaFunction);
        professionalBackupTable.grantReadWriteData(lambdaFunction);
        lambdaFunction.addEnvironment('BACKUP_BUCKET', profBackupsBucket.bucketName);
        lambdaFunction.addEnvironment('PROFESSIONAL_BACKUP_TABLE', professionalBackupTable.tableName);

        // ========================================================================
        // 7. Outputs
        // ========================================================================
        new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
        new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
        new cdk.CfnOutput(this, 'RestApiEndpoint', { value: api.url });
        new cdk.CfnOutput(this, 'WebSocketEndpoint', { value: webSocketApi.apiEndpoint });

        // S3 bucket outputs
        new cdk.CfnOutput(this, 'ProfileImagesBucketName', { value: profileImagesBucket.bucketName });
        new cdk.CfnOutput(this, 'ProfessionalResumesBucketName', { value: professionalResumesBucket.bucketName });
        new cdk.CfnOutput(this, 'VideoResumesBucketName', { value: videoResumesBucket.bucketName });
        new cdk.CfnOutput(this, 'DrivingLicensesBucketName', { value: drivingLicensesBucket.bucketName });
        new cdk.CfnOutput(this, 'ProfessionalLicensesBucketName', { value: professionalLicensesBucket.bucketName });

        // Backup-related outputs
        new cdk.CfnOutput(this, 'ProfBackupsBucketName', { value: profBackupsBucket.bucketName });
        new cdk.CfnOutput(this, 'ProfessionalBackupTableName', { value: professionalBackupTable.tableName });

        // ─── Expose refs to DentiPalChatbotStack (see lib/chatbot-stack.ts) ───
        this.userPool = userPool;
        this.lambdaFunction = lambdaFunction;
        this.chatMessageHandler = chatMessageHandler;
        this.chatMessagesTable = chatMessagesTable;
        this.chatConnectionsTable = chatConnectionsTable;
        this.connectionsTable = connectionsTable;
        this.chatMemoryId = chatMemoryId;
        this.jobPostingsTable = jobPostingsTable;
        this.jobApplicationsTable = jobApplicationsTable;
        this.jobInvitationsTable = jobInvitationsTable;
        this.jobNegotiationsTable = jobNegotiationsTable;
        this.clinicProfilesTable = clinicProfilesTable;
        this.clinicsTable = clinicsTable;
        this.clinicFavoritesTable = clinicFavoritesTable;
        this.userClinicAssignmentsTable = userClinicAssignmentsTable;
        this.professionalProfilesTable = professionalProfilesTable;
        this.userAddressesTable = userAddressesTable;
        this.notificationPreferencesTable = notificationPreferencesTable;
        this.feedbackTable = feedbackTable;
        this.referralsTable = referralsTable;
        this.jobPromotionsTable = jobPromotionsTable;
    }
}
