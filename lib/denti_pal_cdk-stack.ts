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
import * as path from 'path';

export class DentiPalCDKStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ========================================================================
        // 1. Cognito User Pool
        // ========================================================================
        const userPool = new cognito.UserPool(this, 'ClinicUserPoolV5', {
            selfSignUpEnabled: true,
            autoVerify: { email: true },
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
            'DualRoleFrontDA',
            'DentalHygienist',
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
            // clinic address fields on JobPostings in sync after address edits.
            stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
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

        // Notification preferences (smart-notifications feature).
        // PK: userSub (Cognito sub). One row per user. Defaults are all-true so
        // a missing row = "send everything" — the get/update handlers backfill on read.
        const notificationPreferencesTable = new dynamodb.Table(this, 'NotificationPreferencesTable', {
            tableName: 'DentiPal-V5-NotificationPreferences',
            partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
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

        // Collect all tables for the main REST handler
        const allTables = [
            clinicProfilesTable, clinicFavoritesTable, clinicsTable, connectionsTable,
            conversationsTable, feedbackTable, jobApplicationsTable, jobInvitationsTable,
            jobNegotiationsTable, jobPostingsTable, messagesTable,
            professionalProfilesTable, referralsTable, userAddressesTable,
            userClinicAssignmentsTable, jobPromotionsTable,
            leadsTable, leadActivityTable, bansTable,
            notificationPreferencesTable,
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
                SES_REGION: this.region,
                SES_TO: 'shashitest2004@gmail.com',     // Updated per your env variables
                SMS_TOPIC_ARN: `arn:aws:sns:${this.region}:${this.account}:DentiPal-SMS-Notifications`, // Dynamic construction
                FRONTEND_ORIGIN: 'http://localhost:5173',
                GOOGLE_CLIENT_ID: '186785894030-o8s1bte9egg9s6a4n61a3jrm6039sep1.apps.googleusercontent.com',
                GOOGLE_CLIENT_SECRET: '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',
                GOOGLE_REDIRECT_URI: 'http://localhost:5173/callback',

                // Table Name Mappings
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
                CLINIC_FAVORITES_TABLE: clinicFavoritesTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                CONNECTIONS_TABLE: connectionsTable.tableName,
                CONVERSATIONS_TABLE: conversationsTable.tableName,
                FEEDBACK_TABLE: feedbackTable.tableName,
                JOB_APPLICATIONS_TABLE: jobApplicationsTable.tableName,
                JOB_INVITATIONS_TABLE: jobInvitationsTable.tableName,
                JOB_NEGOTIATIONS_TABLE: jobNegotiationsTable.tableName,
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                MESSAGES_TABLE: messagesTable.tableName,
                PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName,
                REFERRALS_TABLE: referralsTable.tableName,
                USER_ADDRESSES_TABLE: userAddressesTable.tableName,
                USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
                JOB_PROMOTIONS_TABLE: jobPromotionsTable.tableName,
                LEADS_TABLE: leadsTable.tableName,
                LEAD_ACTIVITY_TABLE: leadActivityTable.tableName,
                BANS_TABLE: bansTable.tableName,

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
                'cognito-idp:AdminEnableUser'
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
            timeout: cdk.Duration.seconds(60),
            memorySize: 256,
            environment: {
                REGION: this.region,
                JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
                CLINICS_TABLE: clinicsTable.tableName,
                CLINIC_PROFILES_TABLE: clinicProfilesTable.tableName,
            },
        });

        // Read jobs by ClinicIdIndex; update jobs by primary key.
        jobPostingsTable.grantReadWriteData(cascadeClinicDataFn);

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
        // This policy allows the handler to send data to any connection within the API
        webSocketChatHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: ['execute-api:ManageConnections'],
            resources: [cdk.Arn.format({
                service: 'execute-api',
                resource: '*', // '*' scope for resource is standard for this action
                resourceName: '*'
            }, this)],
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

        // ========================================================================
        // 6a. Bedrock AgentCore + chatMessage WebSocket route (Phase 1)
        //
        //     New Phase-1 chatbot surface. Adds ONE new `chatMessage` route to
        //     the existing WebSocket API. The route's Lambda invokes a Bedrock
        //     AgentCore agent (Claude Haiku 4.5) and streams tokens back via
        //     PostToConnection. Sessions live in DentiPal-V5-ChatConnections
        //     with a 15-min TTL. Existing $connect / $disconnect routes and
        //     the user-to-user Connections table are unchanged.
        // ========================================================================

        // --- 6a.1 Bedrock Guardrail (PII + prompt-injection + topic filters) ---
        const chatGuardrail = new bedrock.CfnGuardrail(this, 'DentiPalChatGuardrail', {
            name: 'DentiPalChatGuardrail',
            description: 'Shared guardrail for DentiPal chatbot agents — PII redaction, prompt-injection, off-topic filters.',
            blockedInputMessaging: "I can't help with that request.",
            blockedOutputsMessaging: "I can't share that response.",
            sensitiveInformationPolicyConfig: {
                piiEntitiesConfig: [
                    { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
                    { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
                    { type: 'PIN', action: 'BLOCK' },
                ],
            },
            contentPolicyConfig: {
                filtersConfig: [
                    // PROMPT_ATTACK turned OFF on input — the chatbot has no
                    // system-secret to defend, and even MEDIUM was flagging
                    // benign 2-word commands like "search jobs".
                    { type: 'PROMPT_ATTACK', inputStrength: 'NONE', outputStrength: 'NONE' },
                    { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
                    { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
                    { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
                ],
            },
        });

        // --- 6a.2 Service role assumed by Bedrock to invoke the model ---
        const bedrockAgentServiceRole = new iam.Role(this, 'DentiPalBedrockAgentRole', {
            roleName: 'DentiPal-BedrockAgent-ServiceRole',
            assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
            description: 'Service role assumed by Bedrock AgentCore agents to invoke Claude Haiku 4.5.',
        });
        bedrockAgentServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
                // The `us.*` inference profile is a cross-region pointer — it
                // can dispatch to any of us-east-1, us-east-2, us-west-2. The
                // role therefore needs InvokeModel on the foundation-model
                // ARN in every region the profile may route to, plus the
                // profile itself in this region.
                `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
            ],
        }));
        // The agent's orchestration calls ApplyGuardrail on every input/output
        // when a guardrail is attached. Without this, InvokeAgent returns
        // HTTP 200 but the stream contains "Access denied when calling Bedrock."
        bedrockAgentServiceRole.addToPolicy(new iam.PolicyStatement({
            actions: ['bedrock:ApplyGuardrail'],
            resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/${chatGuardrail.attrGuardrailId}`],
        }));

        // --- 6a.3 Professional CfnAgent (Phase 1: no action groups yet) ---
        //
        //     Phase 1 ships the agent without action groups so we can verify
        //     end-to-end connectivity (WebSocket → chatMessage Lambda → Bedrock
        //     → response). Tool calling lands in Phase 2 when we attach action
        //     groups for the search/info/response/audit buckets.
        // Shorthand for parameter defs: AgentCore expects { type, description, required }.
        const P = (type: 'string' | 'number' | 'integer' | 'boolean' | 'array',
                   description: string, required: boolean = false) => ({ type, description, required });
        const STR = (d: string, r = false) => P('string', d, r);
        const NUM = (d: string, r = false) => P('number', d, r);
        const BOOL = (d: string, r = false) => P('boolean', d, r);
        const ARR = (d: string, r = false) => P('array', d, r);

        // Bedrock Agents caps total functions PER AGENT at 11 by default
        // (despite the misleading "APIs in an agent action group" naming the
        // quota is actually agent-wide, not group-wide). Until the quota is
        // raised via AWS support, we ship a curated v1 slice of the catalog.
        // After the quota raises, drop the .filter(...) at the action-group
        // assignment sites and the full toolset returns automatically.
        const PRO_V1_FUNCTIONS = [
            'search_jobs_near_me',
            'get_my_invitations',
            'get_my_applications',
            'get_my_negotiations',
            'get_scheduled_shifts',
            'get_completed_shifts',
            // Single-shot writes (no preview/confirm pair). Match REST API
            // contracts exactly — apply takes only jobId; respond_invitation
            // takes invitationId + response.
            'apply_to_job',
            'respond_invitation',
            // Counter-offer preview/confirm pair kept because rates need review.
            'preview_negotiate',
            'confirm_negotiate',
        ];
        const CLINIC_V1_FUNCTIONS = [
            'get_my_clinics',
            'get_action_needed',
            'list_applicants_for_job',
            'get_professional_info',
            'preview_post_temporary_job',
            'confirm_post_temporary_job',
            'preview_accept_professional',
            'confirm_accept_professional',
            'preview_reject_professional',
            'confirm_reject_professional',
        ];

        const ACTION_GROUP_CHUNK_SIZE = 10;
        const chunkFunctionsIntoActionGroups = (
            baseName: string,
            baseDescription: string,
            functions: any[],
        ): any[] => {
            const groups: any[] = [];
            for (let i = 0; i < functions.length; i += ACTION_GROUP_CHUNK_SIZE) {
                const slice = functions.slice(i, i + ACTION_GROUP_CHUNK_SIZE);
                const idx = groups.length + 1;
                groups.push({
                    actionGroupName: `${baseName}${idx}`,
                    description: `${baseDescription} (part ${idx})`,
                    actionGroupExecutor: { customControl: 'RETURN_CONTROL' },
                    functionSchema: { functions: slice as any },
                });
            }
            return groups;
        };

        // Action-group function schemas. Mirrors the JSON Schemas in
        // lambda/src/handlers/chat/toolSchemas.ts. Kept inline here because
        // CDK synth runs before Lambda compilation.
        const professionalAgentFunctions = [
            // --- search / info ---
            {
                name: 'search_jobs_near_me',
                description: 'Call this IMMEDIATELY whenever the user wants to see jobs, browse work, find shifts, or look for openings. Use NO parameters by default — the server applies a 50-mile radius from the user\'s home automatically and returns active future-dated jobs sorted by distance. Only pass parameters if the user EXPLICITLY narrows by role / date / rate / specialty / job type.',
                parameters: {
                    radiusMiles: NUM('OPTIONAL. Search radius in miles (default 50). Only pass if user asked for a specific distance.'),
                    jobType: STR('OPTIONAL. temporary | multi_day_consulting | permanent. Only pass if user mentioned a specific type.'),
                    professionalRole: STR('OPTIONAL — usually leave UNSET. Server already returns jobs relevant to the user; setting role NARROWS results and often empties them. Only pass if the user explicitly names a DIFFERENT role (e.g. "show me dentist jobs"). Format: snake_case dbValue (dental_hygienist | dentist | associate_dentist | dental_assistant | expanded_functions_da | dual_role_front_da | patient_coordinator_front | treatment_coordinator_front | hygienist | dh_tc_pc). NEVER pass Cognito-group form like "DentalHygienist".'),
                    shiftSpeciality: STR('OPTIONAL. Specialty filter. Only pass if user mentioned one.'),
                    minRate: NUM('OPTIONAL. Minimum rate. Only pass if user specified.'),
                    maxRate: NUM('OPTIONAL. Maximum rate. Only pass if user specified.'),
                    dateFrom: STR('OPTIONAL. ISO date lower bound. Only pass if user specified a date range.'),
                    dateTo: STR('OPTIONAL. ISO date upper bound.'),
                    assistedHygiene: BOOL('OPTIONAL. Only if user asked for assisted-hygiene-only.'),
                    limit: P('integer', 'OPTIONAL. Max results (default 20, max 50).'),
                },
            },
            {
                name: 'apply_to_job',
                description: 'Call this IMMEDIATELY when the user says they want to apply to a job. Required: jobId. Do NOT prompt for rate, message, or availability — those are optional and ONLY passed if the user volunteers them unprompted. Resolve "the third one" / "that job" / "the latest" from the most recent search_jobs_near_me result in conversation memory. This is a single-shot tool — no preview, no confirmation needed.',
                parameters: {
                    jobId: STR('Job UUID, resolved from prior search or user-named.', true),
                    message: STR('OPTIONAL. Cover note. Pass only if user explicitly typed one.'),
                    startDate: STR('OPTIONAL. ISO start date if user specified.'),
                    notes: STR('OPTIONAL. Extra notes from user.'),
                },
            },
            {
                name: 'respond_invitation',
                description: 'Call this IMMEDIATELY when the user wants to accept or decline a clinic invitation. response must be "accepted" or "declined" only. For NEGOTIATING an invitation (counter-offer), DO NOT use this tool — use preview_negotiate instead. Resolve invitationId from get_my_invitations result or from positional reference like "the first invite".',
                parameters: {
                    invitationId: STR('Invitation UUID.', true),
                    response: STR('"accepted" | "declined" — nothing else.', true),
                    message: STR('OPTIONAL. Brief note to clinic.'),
                },
            },
            {
                name: 'preview_negotiate',
                description: 'Call this when the user wants to counter, accept, or decline an active negotiation on one of their applications. If you don\'t have a negotiationId, first call get_my_applications to find it. After this returns a confirm_card, wait for the user to click Confirm — then call confirm_negotiate.',
                parameters: {
                    applicationId: STR('Application UUID.', true),
                    negotiationId: STR('Negotiation UUID. Get from get_my_applications or get_my_negotiations.', true),
                    response: STR('"accepted" | "declined" | "counter_offer".', true),
                    message: STR('OPTIONAL message to clinic.'),
                    professionalCounterRate: NUM('Counter rate for temp jobs (per hour/transaction/percentage). Required if response="counter_offer" on a temp job.'),
                    counterSalaryMin: NUM('Counter salary min (permanent jobs only).'),
                    counterSalaryMax: NUM('Counter salary max (permanent jobs only).'),
                    payType: STR('OPTIONAL pay type override.'),
                },
            },
            {
                name: 'confirm_negotiate',
                description: 'Submit the negotiation response. Only call AFTER the user clicks the confirm-card button (the UI sends a confirmAction frame that bypasses you entirely — so in practice you should never call this directly; it\'s here for completeness).',
                parameters: {
                    previewToken: STR('Token from preview.', true),
                    applicationId: STR('Same as preview.', true),
                    negotiationId: STR('Same as preview.', true),
                    response: STR('Same as preview.', true),
                    message: STR('Same as preview.'),
                    professionalCounterRate: NUM('Same as preview.'),
                    counterSalaryMin: NUM('Same as preview.'),
                    counterSalaryMax: NUM('Same as preview.'),
                    payType: STR('Same as preview.'),
                },
            },
            { name: 'get_job_details', description: 'Get full details for a job by jobId.', parameters: { jobId: STR('Job UUID', true) } },
            { name: 'get_my_applications', description: 'List the professional\'s applications and statuses.', parameters: {} },
            { name: 'get_my_invitations', description: 'List pending clinic invitations.', parameters: {} },
            { name: 'get_my_negotiations', description: 'List the pro\'s open negotiations.', parameters: {} },
            { name: 'get_scheduled_shifts', description: 'List the professional\'s accepted upcoming shifts. No parameters — the pro\'s own applications with status="accepted" or "scheduled" are returned.', parameters: {} },
            { name: 'get_completed_shifts', description: 'List the professional\'s completed shifts. No parameters — returns the pro\'s own completed applications.', parameters: {} },
            // --- response: apply ---
            {
                name: 'preview_apply_to_job',
                description: 'Render a confirm-card for applying. Does NOT submit. Always call BEFORE confirm_apply_to_job.',
                parameters: {
                    jobId: STR('Job UUID', true), message: STR('Cover note', true),
                    proposedRate: NUM('Rate offer', true), availability: STR('Availability', true),
                    startDate: STR('Optional ISO start date'), notes: STR('Optional notes'),
                },
            },
            {
                name: 'confirm_apply_to_job',
                description: 'Submit the application. Requires previewToken; fields must match preview exactly.',
                parameters: {
                    previewToken: STR('Token from preview', true),
                    jobId: STR('Same jobId as preview', true), message: STR('Same message', true),
                    proposedRate: NUM('Same rate', true), availability: STR('Same availability', true),
                    startDate: STR('Same start date'), notes: STR('Same notes'),
                },
            },
            // --- response: invitation ---
            {
                name: 'preview_respond_invitation',
                description: 'Render confirm-card for accepting/declining/negotiating an invitation.',
                parameters: {
                    invitationId: STR('Invitation UUID', true),
                    response: STR('accepted | declined | negotiating', true),
                    message: STR('Optional message'),
                    proposedHourlyRate: NUM('Counter hourly rate'),
                    proposedSalaryMin: NUM('Counter salary min'),
                    proposedSalaryMax: NUM('Counter salary max'),
                    availabilityNotes: STR('Availability notes'),
                    counterProposalMessage: STR('Counter proposal text'),
                },
            },
            {
                name: 'confirm_respond_invitation',
                description: 'Send the invitation response. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token from preview', true),
                    invitationId: STR('Invitation UUID', true),
                    response: STR('accepted | declined | negotiating', true),
                    message: STR('Optional message'),
                    proposedHourlyRate: NUM('Counter hourly rate'),
                    proposedSalaryMin: NUM('Counter salary min'),
                    proposedSalaryMax: NUM('Counter salary max'),
                    availabilityNotes: STR('Availability notes'),
                    counterProposalMessage: STR('Counter proposal text'),
                },
            },
            // --- response: withdraw ---
            {
                name: 'preview_withdraw_application',
                description: 'Render confirm-card for withdrawing an application.',
                parameters: {
                    applicationId: STR('Application UUID', true),
                    reason: STR('Optional reason'),
                },
            },
            {
                name: 'confirm_withdraw_application',
                description: 'Withdraw the application. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token from preview', true),
                    applicationId: STR('Application UUID', true),
                    reason: STR('Optional reason'),
                },
            },
            // --- Phase 4: negotiate, attest, profile, address, notifications, feedback, referral ---
            {
                name: 'preview_negotiate',
                description: 'Render confirm-card for sending a counter-offer / accept / decline on an existing negotiation round.',
                parameters: {
                    applicationId: STR('Application UUID', true),
                    negotiationId: STR('Negotiation UUID', true),
                    response: STR('accepted | declined | counter_offer', true),
                    message: STR('Optional message'),
                    clinicCounterRate: NUM('Counter rate (clinic side)'),
                    professionalCounterRate: NUM('Counter rate (pro side)'),
                    counterSalaryMin: NUM('Counter salary min (permanent)'),
                    counterSalaryMax: NUM('Counter salary max (permanent)'),
                    payType: STR('Pay type'),
                },
            },
            {
                name: 'confirm_negotiate',
                description: 'Send the negotiation response. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    applicationId: STR('Application UUID', true),
                    negotiationId: STR('Negotiation UUID', true),
                    response: STR('Response', true),
                    message: STR('Message'),
                    clinicCounterRate: NUM('Counter rate (clinic)'),
                    professionalCounterRate: NUM('Counter rate (pro)'),
                    counterSalaryMin: NUM('Counter salary min'),
                    counterSalaryMax: NUM('Counter salary max'),
                    payType: STR('Pay type'),
                },
            },
            {
                name: 'preview_attest_completed_shift',
                description: 'Render confirm-card for post-shift attestation.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    attestedHours: NUM('Hours worked', true),
                    attestedRate: NUM('Rate'),
                    signedAt: STR('ISO timestamp', true),
                    notes: STR('Optional notes'),
                },
            },
            {
                name: 'confirm_attest_completed_shift',
                description: 'Submit the attestation. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    attestedHours: NUM('Hours', true),
                    attestedRate: NUM('Rate'),
                    signedAt: STR('ISO', true),
                    notes: STR('Notes'),
                },
            },
            {
                name: 'preview_update_my_profile',
                description: 'Render confirm-card for updating the pro profile. Pass only fields to change.',
                parameters: {
                    first_name: STR('First name'), last_name: STR('Last name'),
                    role: STR('Cognito role group'),
                    specialties: ARR('Specialties'),
                    bio: STR('Bio'),
                    years_experience: NUM('Years of experience'),
                    license_number: STR('License number'),
                    license_state: STR('License state'),
                },
            },
            {
                name: 'confirm_update_my_profile',
                description: 'Apply the profile update. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    first_name: STR('First name'), last_name: STR('Last name'),
                    role: STR('Role'), specialties: ARR('Specialties'),
                    bio: STR('Bio'), years_experience: NUM('Years'),
                    license_number: STR('License number'), license_state: STR('State'),
                },
            },
            {
                name: 'preview_update_home_address',
                description: 'Render confirm-card for updating the pro\'s home address. Used for radius search.',
                parameters: {
                    addressLine1: STR('Street line 1', true),
                    addressLine2: STR('Optional line 2'),
                    addressLine3: STR('Optional line 3'),
                    city: STR('City', true), state: STR('State', true),
                    pincode: STR('ZIP/postal', true), country: STR('Country (default USA)'),
                },
            },
            {
                name: 'confirm_update_home_address',
                description: 'Save the home address. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    addressLine1: STR('Line 1', true), addressLine2: STR('Line 2'),
                    addressLine3: STR('Line 3'),
                    city: STR('City', true), state: STR('State', true),
                    pincode: STR('ZIP', true), country: STR('Country'),
                },
            },
            {
                name: 'preview_update_notification_preferences',
                description: 'Render confirm-card for notification preference changes.',
                parameters: {
                    emailEnabled: BOOL('Email toggle'),
                    smsEnabled: BOOL('SMS toggle'),
                    pushEnabled: BOOL('Push toggle'),
                    jobInvitations: BOOL('Job invitations'),
                    applicationUpdates: BOOL('Application updates'),
                    negotiationUpdates: BOOL('Negotiation updates'),
                    shiftReminders: BOOL('Shift reminders'),
                },
            },
            {
                name: 'confirm_update_notification_preferences',
                description: 'Save notification preferences. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    emailEnabled: BOOL('Email'), smsEnabled: BOOL('SMS'), pushEnabled: BOOL('Push'),
                    jobInvitations: BOOL('Invites'), applicationUpdates: BOOL('Apps'),
                    negotiationUpdates: BOOL('Negs'), shiftReminders: BOOL('Reminders'),
                },
            },
            {
                name: 'preview_submit_feedback',
                description: 'Render confirm-card for submitting feedback / dispute.',
                parameters: {
                    type: STR('Feedback type', true),
                    feedback: STR('Feedback text', true),
                    rating: NUM('1-5 rating'),
                    targetUserSub: STR('Target pro userSub'),
                    targetClinicId: STR('Target clinic UUID'),
                    jobId: STR('Job UUID'),
                },
            },
            {
                name: 'confirm_submit_feedback',
                description: 'Submit the feedback. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    type: STR('Type', true), feedback: STR('Feedback', true),
                    rating: NUM('Rating'),
                    targetUserSub: STR('Target userSub'),
                    targetClinicId: STR('Target clinic'),
                    jobId: STR('Job UUID'),
                },
            },
            {
                name: 'preview_send_referral',
                description: 'Render confirm-card for referring another professional via email.',
                parameters: {
                    referredEmail: STR('Email of person being referred', true),
                    referredName: STR('Their name', true),
                    message: STR('Optional personal message'),
                },
            },
            {
                name: 'confirm_send_referral',
                description: 'Send the referral invite. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    referredEmail: STR('Email', true),
                    referredName: STR('Name', true),
                    message: STR('Message'),
                },
            },
        ];

        // -------- Clinic agent function schemas --------
        const clinicAgentFunctions = [
            // --- info ---
            { name: 'get_my_clinics', description: 'List clinics the current user manages. Use BEFORE post_*_job.', parameters: {} },
            { name: 'get_action_needed', description: 'List items needing the clinic\'s action.', parameters: { clinicId: STR('Clinic UUID', true) } },
            { name: 'get_open_shifts', description: 'List upcoming unfilled shifts for a clinic.', parameters: { clinicId: STR('Clinic UUID', true) } },
            { name: 'get_scheduled_shifts', description: 'List accepted, future shifts for a clinic.', parameters: { clinicId: STR('Optional clinic filter') } },
            { name: 'get_completed_shifts', description: 'List completed shifts for a clinic.', parameters: { clinicId: STR('Optional clinic filter') } },
            { name: 'list_applicants_for_job', description: 'List applicants for a specific job.', parameters: { clinicId: STR('Clinic UUID', true), jobId: STR('Optional jobId') } },
            { name: 'get_professional_info', description: 'Get a professional\'s public profile.', parameters: { userSub: STR('Pro userSub', true) } },
            { name: 'get_clinic_favorites', description: 'List the clinic\'s favorite pros.', parameters: {} },
            { name: 'get_job_details', description: 'Get full details for a job by jobId.', parameters: { jobId: STR('Job UUID', true) } },
            // --- response: post jobs ---
            {
                name: 'preview_post_temporary_job',
                description: 'Render confirm-card for a single-shift temp job. Call BEFORE confirm_post_temporary_job.',
                parameters: {
                    clinicIds: ARR('Clinic UUIDs to post to', true),
                    professional_role: STR('Required role', true),
                    professional_roles: ARR('Optional multi-role'),
                    date: STR('ISO date (today/future)', true),
                    shift_speciality: STR('Specialty', true),
                    hours: NUM('Hours (1-12)', true), rate: NUM('Rate', true),
                    pay_type: STR('per_hour | per_transaction | percentage_of_revenue'),
                    start_time: STR('HH:MM', true), end_time: STR('HH:MM', true),
                    meal_break: STR('Free-text or duration'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements list'),
                    assisted_hygiene: BOOL('Assisted hygiene flag'),
                    work_location_type: STR('onsite | us_remote | global_remote'),
                },
            },
            {
                name: 'confirm_post_temporary_job',
                description: 'Create the temp job. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicIds: ARR('Clinic UUIDs', true), professional_role: STR('Role', true),
                    professional_roles: ARR('Multi-role'), date: STR('ISO date', true),
                    shift_speciality: STR('Specialty', true),
                    hours: NUM('Hours', true), rate: NUM('Rate', true),
                    pay_type: STR('Pay type'),
                    start_time: STR('HH:MM', true), end_time: STR('HH:MM', true),
                    meal_break: STR('Meal break'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    assisted_hygiene: BOOL('Assisted hygiene flag'),
                    work_location_type: STR('Work location'),
                },
            },
            {
                name: 'preview_post_consulting_job',
                description: 'Render confirm-card for a multi-day consulting job.',
                parameters: {
                    clinicIds: ARR('Clinic UUIDs', true), professional_role: STR('Role', true),
                    professional_roles: ARR('Multi-role'),
                    dates: ARR('ISO dates list', true),
                    total_days: NUM('Total days', true), hours_per_day: NUM('Hours/day', true),
                    shift_speciality: STR('Specialty', true), rate: NUM('Rate', true),
                    pay_type: STR('Pay type'),
                    start_time: STR('HH:MM', true), end_time: STR('HH:MM', true),
                    meal_break: STR('Meal break'),
                    project_duration: STR('Free-text duration'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    work_location_type: STR('Work location'),
                },
            },
            {
                name: 'confirm_post_consulting_job',
                description: 'Create the consulting job. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicIds: ARR('Clinic UUIDs', true), professional_role: STR('Role', true),
                    professional_roles: ARR('Multi-role'), dates: ARR('Dates', true),
                    total_days: NUM('Total days', true), hours_per_day: NUM('Hours/day', true),
                    shift_speciality: STR('Specialty', true), rate: NUM('Rate', true),
                    pay_type: STR('Pay type'),
                    start_time: STR('HH:MM', true), end_time: STR('HH:MM', true),
                    meal_break: STR('Meal break'),
                    project_duration: STR('Duration'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    work_location_type: STR('Work location'),
                },
            },
            {
                name: 'preview_post_permanent_job',
                description: 'Render confirm-card for a permanent job.',
                parameters: {
                    clinicIds: ARR('Clinic UUIDs', true),
                    professional_role: STR('Role', true), professional_roles: ARR('Multi-role'),
                    shift_speciality: STR('Specialty', true),
                    employment_type: STR('full_time | part_time', true),
                    salary_min: NUM('Salary min'), salary_max: NUM('Salary max'),
                    benefits: ARR('Benefits list (can be empty array)', true),
                    vacation_days: NUM('Vacation days (0-50)'),
                    work_schedule: STR('Free-text schedule'),
                    start_date: STR('ISO start date'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    work_location_type: STR('Work location'),
                    pay_type: STR('Pay type'), rate: NUM('Rate'),
                },
            },
            {
                name: 'confirm_post_permanent_job',
                description: 'Create the permanent job. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicIds: ARR('Clinic UUIDs', true),
                    professional_role: STR('Role', true), professional_roles: ARR('Multi-role'),
                    shift_speciality: STR('Specialty', true),
                    employment_type: STR('Employment type', true),
                    salary_min: NUM('Salary min'), salary_max: NUM('Salary max'),
                    benefits: ARR('Benefits', true),
                    vacation_days: NUM('Vacation days'),
                    work_schedule: STR('Schedule'),
                    start_date: STR('Start date'),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    work_location_type: STR('Work location'),
                    pay_type: STR('Pay type'), rate: NUM('Rate'),
                },
            },
            // --- response: applicant decisions ---
            {
                name: 'preview_accept_professional',
                description: 'Render confirm-card for hiring an applicant.',
                parameters: {
                    jobId: STR('Job UUID', true), professionalUserSub: STR('Pro userSub', true),
                    acceptedRate: NUM('Final rate'), message: STR('Optional message'),
                },
            },
            {
                name: 'confirm_accept_professional',
                description: 'Hire the applicant. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true), professionalUserSub: STR('Pro userSub', true),
                    acceptedRate: NUM('Rate'), message: STR('Message'),
                },
            },
            {
                name: 'preview_reject_professional',
                description: 'Render confirm-card for rejecting an applicant.',
                parameters: {
                    clinicId: STR('Clinic UUID', true), jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true), reason: STR('Optional reason'),
                },
            },
            {
                name: 'confirm_reject_professional',
                description: 'Reject the applicant. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicId: STR('Clinic UUID', true), jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true), reason: STR('Reason'),
                },
            },
            // --- response: invitations ---
            {
                name: 'preview_send_invitations',
                description: 'Render confirm-card for inviting pros to a job.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    professionalUserSubs: ARR('Pro userSubs to invite', true),
                    invitationMessage: STR('Optional message'),
                    urgency: STR('low | medium | high'),
                },
            },
            {
                name: 'confirm_send_invitations',
                description: 'Send the invitations. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    professionalUserSubs: ARR('Pro userSubs', true),
                    invitationMessage: STR('Message'),
                    urgency: STR('Urgency'),
                },
            },
            // --- Phase 4: counter-negotiate, mark-completed, no-show, edit/cancel jobs,
            //              favorites, search pros, team management, profile, feedback ---
            {
                name: 'preview_negotiate',
                description: 'Render confirm-card for the clinic to counter / accept / decline a pro\'s negotiation round.',
                parameters: {
                    applicationId: STR('Application UUID', true),
                    negotiationId: STR('Negotiation UUID', true),
                    response: STR('accepted | declined | counter_offer', true),
                    message: STR('Message'),
                    clinicCounterRate: NUM('Clinic counter rate'),
                    counterSalaryMin: NUM('Counter salary min (permanent)'),
                    counterSalaryMax: NUM('Counter salary max (permanent)'),
                    payType: STR('Pay type'),
                },
            },
            {
                name: 'confirm_negotiate',
                description: 'Send the negotiation response. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    applicationId: STR('Application UUID', true),
                    negotiationId: STR('Negotiation UUID', true),
                    response: STR('Response', true), message: STR('Message'),
                    clinicCounterRate: NUM('Rate'),
                    counterSalaryMin: NUM('Min'), counterSalaryMax: NUM('Max'),
                    payType: STR('Pay type'),
                },
            },
            {
                name: 'preview_mark_shift_completed',
                description: 'Render confirm-card for clinic-side post-shift completion attestation.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true),
                    attestedHours: NUM('Hours worked', true),
                    attestedRate: NUM('Rate'),
                    clinicNotes: STR('Notes'),
                },
            },
            {
                name: 'confirm_mark_shift_completed',
                description: 'Confirm the shift completion. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true),
                    attestedHours: NUM('Hours', true),
                    attestedRate: NUM('Rate'), clinicNotes: STR('Notes'),
                },
            },
            {
                name: 'preview_report_no_show',
                description: 'Render confirm-card for reporting a professional no-show.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true),
                    reason: STR('Reason', true),
                    details: STR('Optional details'),
                },
            },
            {
                name: 'confirm_report_no_show',
                description: 'Submit the no-show report. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    professionalUserSub: STR('Pro userSub', true),
                    reason: STR('Reason', true), details: STR('Details'),
                },
            },
            {
                name: 'preview_update_clinic_profile',
                description: 'Render confirm-card for clinic profile edits. Pass only fields to change.',
                parameters: {
                    clinicId: STR('Clinic UUID', true),
                    clinic_name: STR('Display name'),
                    clinic_type: STR('Clinic type'),
                    practice_type: STR('Practice type'),
                    primary_practice_area: STR('Primary area'),
                    primary_contact_first_name: STR('Contact first name'),
                    primary_contact_last_name: STR('Contact last name'),
                    assisted_hygiene_available: BOOL('Assisted hygiene?'),
                    number_of_operatories: NUM('Operatories'),
                    num_hygienists: NUM('Hygienists'),
                    num_assistants: NUM('Assistants'),
                    num_doctors: NUM('Doctors'),
                    booking_out_period: STR('Booking lead time'),
                    clinic_software: STR('Primary software'),
                    software_used: ARR('All software'),
                    parking_type: STR('Parking type'),
                    parking_cost: NUM('Parking cost'),
                    free_parking_available: BOOL('Free parking?'),
                    addressLine1: STR('Line 1'), addressLine2: STR('Line 2'), addressLine3: STR('Line 3'),
                    city: STR('City'), state: STR('State'), zipCode: STR('ZIP'),
                    contact_email: STR('Email'), contact_phone: STR('Phone'),
                    special_requirements: ARR('Special requirements'),
                    notes: STR('Notes'), description: STR('Description'),
                },
            },
            {
                name: 'confirm_update_clinic_profile',
                description: 'Save clinic profile edits. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicId: STR('Clinic UUID', true),
                    clinic_name: STR('Name'), clinic_type: STR('Type'),
                    practice_type: STR('Practice'), primary_practice_area: STR('Area'),
                    primary_contact_first_name: STR('First'),
                    primary_contact_last_name: STR('Last'),
                    assisted_hygiene_available: BOOL('AH'),
                    number_of_operatories: NUM('Ops'),
                    num_hygienists: NUM('Hyg'), num_assistants: NUM('DA'), num_doctors: NUM('Doc'),
                    booking_out_period: STR('Booking'),
                    clinic_software: STR('Software'),
                    software_used: ARR('Software list'),
                    parking_type: STR('Parking'),
                    parking_cost: NUM('Cost'),
                    free_parking_available: BOOL('Free parking'),
                    addressLine1: STR('Line 1'), addressLine2: STR('Line 2'), addressLine3: STR('Line 3'),
                    city: STR('City'), state: STR('State'), zipCode: STR('ZIP'),
                    contact_email: STR('Email'), contact_phone: STR('Phone'),
                    special_requirements: ARR('Requirements'),
                    notes: STR('Notes'), description: STR('Description'),
                },
            },
            {
                name: 'preview_edit_job',
                description: 'Render confirm-card for editing an existing job. Pass only fields to change.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Requirements'),
                    hours: NUM('Hours'), rate: NUM('Rate'), pay_type: STR('Pay type'),
                    start_time: STR('Start'), end_time: STR('End'),
                    meal_break: STR('Meal break'),
                    date: STR('Date (temp)'),
                    dates: ARR('Dates (consulting)'),
                    hours_per_day: NUM('Hours/day'), total_days: NUM('Total days'),
                    salary_min: NUM('Salary min'), salary_max: NUM('Salary max'),
                    benefits: ARR('Benefits'),
                    employment_type: STR('Employment type'),
                    vacation_days: NUM('Vacation days'),
                    work_schedule: STR('Schedule'),
                },
            },
            {
                name: 'confirm_edit_job',
                description: 'Apply the edits. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    job_title: STR('Title'), job_description: STR('Description'),
                    requirements: ARR('Reqs'),
                    hours: NUM('Hours'), rate: NUM('Rate'), pay_type: STR('Pay type'),
                    start_time: STR('Start'), end_time: STR('End'),
                    meal_break: STR('Break'),
                    date: STR('Date'), dates: ARR('Dates'),
                    hours_per_day: NUM('H/d'), total_days: NUM('Days'),
                    salary_min: NUM('Min'), salary_max: NUM('Max'),
                    benefits: ARR('Benefits'),
                    employment_type: STR('Type'),
                    vacation_days: NUM('Vacation'),
                    work_schedule: STR('Schedule'),
                },
            },
            {
                name: 'preview_cancel_job',
                description: 'Render confirm-card for cancelling/deactivating a job posting.',
                parameters: {
                    jobId: STR('Job UUID', true),
                    reason: STR('Optional reason'),
                },
            },
            {
                name: 'confirm_cancel_job',
                description: 'Mark the job inactive. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    jobId: STR('Job UUID', true),
                    reason: STR('Reason'),
                },
            },
            {
                name: 'preview_add_clinic_favorite',
                description: 'Render confirm-card for adding a pro to the clinic\'s favorites.',
                parameters: { professionalUserSub: STR('Pro userSub', true) },
            },
            {
                name: 'confirm_add_clinic_favorite',
                description: 'Save the favorite. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    professionalUserSub: STR('Pro userSub', true),
                },
            },
            {
                name: 'preview_remove_clinic_favorite',
                description: 'Render confirm-card for removing a favorite.',
                parameters: { professionalUserSub: STR('Pro userSub', true) },
            },
            {
                name: 'confirm_remove_clinic_favorite',
                description: 'Remove the favorite. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    professionalUserSub: STR('Pro userSub', true),
                },
            },
            {
                name: 'search_professionals',
                description: 'Find professionals by role/specialty. Use BEFORE preview_send_invitations to pick targets.',
                parameters: {
                    role: STR('Role filter'),
                    speciality: STR('Specialty filter'),
                    limit: NUM('Max results'),
                },
            },
            {
                name: 'preview_invite_team_member',
                description: 'Render confirm-card for inviting a teammate (ClinicManager/ClinicViewer).',
                parameters: {
                    clinicId: STR('Clinic UUID', true),
                    email: STR('Teammate email', true),
                    role: STR('ClinicManager | ClinicViewer', true),
                    first_name: STR('First name'),
                    last_name: STR('Last name'),
                },
            },
            {
                name: 'confirm_invite_team_member',
                description: 'Send the team invite. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    clinicId: STR('Clinic UUID', true),
                    email: STR('Email', true),
                    role: STR('Role', true),
                    first_name: STR('First'),
                    last_name: STR('Last'),
                },
            },
            {
                name: 'preview_update_team_member',
                description: 'Render confirm-card for changing a teammate\'s role.',
                parameters: {
                    userSub: STR('Teammate userSub', true),
                    clinicId: STR('Clinic UUID', true),
                    role: STR('ClinicAdmin | ClinicManager | ClinicViewer', true),
                },
            },
            {
                name: 'confirm_update_team_member',
                description: 'Save the role change. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    userSub: STR('userSub', true),
                    clinicId: STR('Clinic UUID', true),
                    role: STR('Role', true),
                },
            },
            {
                name: 'preview_remove_team_member',
                description: 'Render confirm-card for removing a teammate.',
                parameters: {
                    userSub: STR('Teammate userSub', true),
                    clinicId: STR('Clinic UUID', true),
                },
            },
            {
                name: 'confirm_remove_team_member',
                description: 'Remove the teammate. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    userSub: STR('userSub', true),
                    clinicId: STR('Clinic UUID', true),
                },
            },
            // Shared with pro agent — clinics also submit feedback and tune their own notification prefs.
            {
                name: 'preview_submit_feedback',
                description: 'Render confirm-card for submitting feedback / dispute.',
                parameters: {
                    type: STR('Feedback type', true),
                    feedback: STR('Feedback text', true),
                    rating: NUM('1-5 rating'),
                    targetUserSub: STR('Target userSub'),
                    targetClinicId: STR('Target clinic'),
                    jobId: STR('Job UUID'),
                },
            },
            {
                name: 'confirm_submit_feedback',
                description: 'Submit the feedback. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    type: STR('Type', true), feedback: STR('Feedback', true),
                    rating: NUM('Rating'),
                    targetUserSub: STR('Target userSub'),
                    targetClinicId: STR('Target clinic'),
                    jobId: STR('Job UUID'),
                },
            },
            {
                name: 'preview_update_notification_preferences',
                description: 'Render confirm-card for notification preference changes.',
                parameters: {
                    emailEnabled: BOOL('Email'), smsEnabled: BOOL('SMS'), pushEnabled: BOOL('Push'),
                    jobInvitations: BOOL('Invites'), applicationUpdates: BOOL('Apps'),
                    negotiationUpdates: BOOL('Negs'), shiftReminders: BOOL('Reminders'),
                },
            },
            {
                name: 'confirm_update_notification_preferences',
                description: 'Save notification preferences. Requires previewToken.',
                parameters: {
                    previewToken: STR('Token', true),
                    emailEnabled: BOOL('Email'), smsEnabled: BOOL('SMS'), pushEnabled: BOOL('Push'),
                    jobInvitations: BOOL('Invites'), applicationUpdates: BOOL('Apps'),
                    negotiationUpdates: BOOL('Negs'), shiftReminders: BOOL('Reminders'),
                },
            },
        ];

        const professionalAgent = new bedrock.CfnAgent(this, 'DentiPalProfessionalAgentV2', {
            agentName: 'DentiPal-Professional-Agent',
            description: 'DentiPal natural-language assistant for dental professionals — search jobs, apply, negotiate, manage shifts.',
            agentResourceRoleArn: bedrockAgentServiceRole.roleArn,
            foundationModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            // Auto-prepare DRAFT on every deploy so the live alias actually
            // serves the new tool list. Without this, CfnAgent updates land in
            // DRAFT but the numbered version (which the alias serves) stays
            // stuck on the original deploy — agent uses stale legacy tools.
            autoPrepare: true,
            idleSessionTtlInSeconds: 900, // 15 min, matches ChatConnections TTL
            instruction: [
                '═══ ROLE ═══',
                'You serve DENTAL PROFESSIONALS ONLY. The user is a hygienist / dentist / assistant looking for shifts. They DO NOT own or manage clinics. They DO NOT post jobs. They DO NOT see applicants. They APPLY to jobs that clinics post.',
                'NEVER ask the user "which clinic?" — they don\'t have any. NEVER act as if they have a clinicId. NEVER mention posting jobs.',
                '═══════════',
                '',
                'Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool with sensible defaults from their context. DO NOT ask clarifying questions before calling a tool — only ask if a tool returns an error naming a missing field.',
                '',
                'Intent → tool map (call IMMEDIATELY, no questions):',
                '- "search jobs" / "find work" / "show shifts" / "what\'s available" → search_jobs_near_me with NO parameters. The server already knows the user\'s 50-mile radius from their home address.',
                '- "apply to N" / "apply to that one" / "apply to the third one" → apply_to_job with just {jobId: <resolved from prior search results>}. NEVER ask for rate, message, or availability — those are optional.',
                '- "my invites" / "who invited me" → get_my_invitations.',
                '- "accept invite N" / "decline invite N" → respond_invitation with {invitationId, response: "accepted"|"declined"}. No follow-up questions.',
                '- "my applications" / "what did I apply to" → get_my_applications.',
                '- "scheduled shifts" / "upcoming work" → get_scheduled_shifts.',
                '- "completed shifts" / "what have I done" → get_completed_shifts.',
                '- "negotiate $X on application Y" / "counter at $X" → preview_negotiate with the rate. The system renders a confirm card; the user clicks Confirm; you don\'t need to call confirm_negotiate yourself (a UI confirmAction handles it).',
                '',
                'Reference resolution (no questions):',
                '- "the first/second/third one", "that job", "the latest" → resolve from the MOST RECENT tool result in your conversation memory. Don\'t ask the user "which one?".',
                '- "negotiate on my latest" → call get_my_applications first if needed, then use the most recent applicationId + its negotiationId.',
                '',
                'Apply vs. negotiate (important):',
                '- Pure apply (apply_to_job) DOES NOT take any rate. The clinic\'s posted rate is implicit.',
                '- Rates only come into play during a negotiation (preview_negotiate). If the user says "apply at $80", interpret as a counter-offer flow: call apply_to_job first to create the application, then preview_negotiate to send the counter.',
                '',
                'When a tool returns results, summarize concisely in 1-2 sentences AND let the rendered card do the heavy lifting. Don\'t dump JSON. Don\'t list every field. Trust the UI to show the list.',
                '',
                'NEVER paraphrase or guess numbers, dates, rates, names, or IDs from a tool result — use them verbatim or refer to the card. If the tool returned zero results, say so plainly ("you have no scheduled shifts right now") instead of fabricating.',
            ].join('\n'),
            guardrailConfiguration: {
                guardrailIdentifier: chatGuardrail.attrGuardrailId,
                guardrailVersion: 'DRAFT',
            },
            // v1 slim list — Bedrock currently caps total functions per agent
            // at 11. We keep the 10 most essential covering the user's spec
            // (search, apply, respond invitation, scheduled/completed shifts,
            // applications, negotiations summary). Restore full list after
            // the "Number of APIs per agent" quota is raised via support.
            actionGroups: chunkFunctionsIntoActionGroups(
                'DentiPalProTools',
                'Professional-agent tools — search jobs, apply, respond to invitations.',
                professionalAgentFunctions.filter(f => PRO_V1_FUNCTIONS.includes(f.name)),
            ),
        });
        professionalAgent.addDependency(chatGuardrail);

        const professionalAgentAlias = new bedrock.CfnAgentAlias(this, 'DentiPalProfessionalAgentAliasV2', {
            agentAliasName: 'live',
            agentId: professionalAgent.attrAgentId,
            description: 'Production alias for the professional agent.',
        });

        // --- 6a.3b Clinic CfnAgent ---
        const clinicAgent = new bedrock.CfnAgent(this, 'DentiPalClinicAgentV2', {
            agentName: 'DentiPal-Clinic-Agent',
            description: 'DentiPal natural-language assistant for clinic staff — post jobs, manage applicants, hire/reject, see action-needed.',
            agentResourceRoleArn: bedrockAgentServiceRole.roleArn,
            foundationModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            // Same reason as the pro agent — without this every CDK update
            // gets stuck in DRAFT.
            autoPrepare: true,
            idleSessionTtlInSeconds: 900,
            instruction: [
                '═══ ROLE ═══',
                'You serve DENTAL CLINIC STAFF ONLY. The user is a clinic admin / manager. They MANAGE clinics. They POST jobs. They REVIEW applicants and HIRE professionals. They DO NOT apply to jobs themselves. They DO NOT have scheduled shifts of their own.',
                'NEVER act as if the user is a professional looking for work. NEVER call professional-side tools like search_jobs_near_me or apply_to_job.',
                '═══════════',
                '',
                'Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool. DO NOT ask clarifying questions before calling a tool — only ask if a tool returns an error naming a missing field.',
                '',
                'Intent → tool map (call IMMEDIATELY):',
                '- "my clinics" / "which clinics do I manage" → get_my_clinics.',
                '- "what needs my attention" / "action items" / "what\'s pending" → get_action_needed. (If multiple clinics exist and user didn\'t name one, silently pick the first from get_my_clinics — don\'t ask.)',
                '- "who applied to job X" / "applicants" → list_applicants_for_job.',
                '- "show me <name>\'s profile" / "tell me about that pro" → get_professional_info.',
                '- "post a temp shift" / "post a job" → preview_post_temporary_job (then wait for user confirm).',
                '- "accept <pro>" / "hire <pro> for job X" → preview_accept_professional → wait for confirm.',
                '- "reject <pro>" / "decline <pro>" → preview_reject_professional → wait for confirm.',
                '',
                'Resolution rules (no questions):',
                '- If user manages exactly ONE clinic, auto-pass that clinicId for every tool that needs one. Don\'t ask "which clinic?".',
                '- Resolve "the first applicant" / "that pro" / "the latest" from the most recent tool result in conversation memory.',
                '- When the user names a clinic (e.g., "Qwerty Clinic"), look up its UUID from your earlier get_my_clinics result. Pass the UUID, NOT the name, to job-post tools. clinicIds is always an array of UUIDs: ["a1b2c3..."] — never a name or comma-separated string.',
                '',
                'When a tool returns an error (e.g. validation), THEN and only then ask the user for the specific missing field. Never pre-emptively interrogate.',
                '',
                'When a tool returns results, summarize concisely in 1-2 sentences and let the rendered card show the details. Don\'t dump JSON or list every field.',
                '',
                'NEVER paraphrase or guess numbers, dates, rates, names, or IDs from a tool result — use them verbatim or refer to the card. If the tool returned zero results, say so plainly instead of fabricating.',
            ].join('\n'),
            guardrailConfiguration: {
                guardrailIdentifier: chatGuardrail.attrGuardrailId,
                guardrailVersion: 'DRAFT',
            },
            actionGroups: chunkFunctionsIntoActionGroups(
                'DentiPalClinicTools',
                'Clinic-agent tools — post temp jobs, manage applicants, hire/reject.',
                clinicAgentFunctions.filter(f => CLINIC_V1_FUNCTIONS.includes(f.name)),
            ),
        });
        clinicAgent.addDependency(chatGuardrail);

        const clinicAgentAlias = new bedrock.CfnAgentAlias(this, 'DentiPalClinicAgentAliasV2', {
            agentAliasName: 'live',
            agentId: clinicAgent.attrAgentId,
            description: 'Production alias for the clinic agent.',
        });

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
                // Bedrock agent + alias IDs (Phase 2: pro + clinic; public follows in Phase 3)
                BEDROCK_PROFESSIONAL_AGENT_ID: professionalAgent.attrAgentId,
                BEDROCK_PROFESSIONAL_AGENT_ALIAS_ID: professionalAgentAlias.attrAgentAliasId,
                BEDROCK_CLINIC_AGENT_ID: clinicAgent.attrAgentId,
                BEDROCK_CLINIC_AGENT_ALIAS_ID: clinicAgentAlias.attrAgentAliasId,
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
        // Phase 4: notifications, feedback, referrals
        notificationPreferencesTable.grantReadWriteData(chatMessageHandler);
        feedbackTable.grantReadWriteData(chatMessageHandler);
        referralsTable.grantReadWriteData(chatMessageHandler);

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
        chatMessageHandler.addToRolePolicy(new iam.PolicyStatement({
            actions: [
                'bedrock:InvokeAgent',
                'bedrock-agent-runtime:InvokeAgent',
                'bedrock:GetAgent',
                'bedrock:GetAgentAlias',
                'bedrock:ApplyGuardrail',
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
            ],
            resources: [
                // Agents + aliases
                `arn:aws:bedrock:${this.region}:${this.account}:agent/${professionalAgent.attrAgentId}`,
                `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${professionalAgent.attrAgentId}/${professionalAgentAlias.attrAgentAliasId}`,
                `arn:aws:bedrock:${this.region}:${this.account}:agent/${clinicAgent.attrAgentId}`,
                `arn:aws:bedrock:${this.region}:${this.account}:agent-alias/${clinicAgent.attrAgentId}/${clinicAgentAlias.attrAgentAliasId}`,
                // Guardrail (any version)
                `arn:aws:bedrock:${this.region}:${this.account}:guardrail/${chatGuardrail.attrGuardrailId}`,
                // Foundation model + inference profile — some accounts require
                // InvokeModel on the runtime caller's role too.
                `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
            ],
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

        // --- 6a.5 Mount the new `chatMessage` route on the existing API ---
        webSocketApi.addRoute('chatMessage', {
            integration: new apigwv2integrations.WebSocketLambdaIntegration(
                'ChatMessageIntegration',
                chatMessageHandler,
            ),
        });

        new cdk.CfnOutput(this, 'ChatMessageHandlerName', { value: chatMessageHandler.functionName });
        new cdk.CfnOutput(this, 'BedrockProfessionalAgentId', { value: professionalAgent.attrAgentId });
        new cdk.CfnOutput(this, 'BedrockProfessionalAgentAliasId', { value: professionalAgentAlias.attrAgentAliasId });
        new cdk.CfnOutput(this, 'BedrockClinicAgentId', { value: clinicAgent.attrAgentId });
        new cdk.CfnOutput(this, 'BedrockClinicAgentAliasId', { value: clinicAgentAlias.attrAgentAliasId });

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
    }
}
