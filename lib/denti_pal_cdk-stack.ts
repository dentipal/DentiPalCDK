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

    const client = userPool.addClient('ClinicAppClientV5', {
      authFlows: { userPassword: true, userSrp: true },
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
      // You should adjust the groups in the CfnUserPoolGroup list 
      // to match the exact strings used in your Lambda code for authorization.
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

    // Reusing the table definitions from your original stack
    // (A full list of tables is omitted here for brevity, assuming they are unchanged)
    
    // 1. DentiPal-Clinic-Profiles
    const clinicProfilesTable = new dynamodb.Table(this, 'ClinicProfilesTable', {
        tableName: 'DentiPal-V5-Clinic-Profiles',
        partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
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
      // The original stack had multiple indexes with potentially similar names, 
      // ensuring unique index names for the CDK construct:
      connectionsTable.addGlobalSecondaryIndex({
        indexName: 'connectionId-index',
        partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      // Note: The original stack had clinicKey-index and profKey-index listed but 
      // these columns don't appear in the ConnectionsTable definition provided 
      // (only userKey and connectionId). Assuming the connectionId-index is what 
      // is primarily needed for lookups by ID. I've removed the redundant or 
      // potentially misleading indices from the CDK code.
  
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
      // Renamed one of the duplicate JobIdIndex definitions
      jobPostingsTable.addGlobalSecondaryIndex({
        indexName: 'jobId-index-1',
        partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      jobPostingsTable.addGlobalSecondaryIndex({
        indexName: 'JobIdIndex-2',
        partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
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
      messagesTable.addGlobalSecondaryIndex({
        indexName: 'ConversationIdIndex',
        partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
        projectionType: dynamodb.ProjectionType.ALL,
      });
      
      // 12. DentiPal-Notifications
      const notificationsTable = new dynamodb.Table(this, 'NotificationsTable', {
        tableName: 'DentiPal-V5-Notifications',
        partitionKey: { name: 'recipientUserSub', type: dynamodb.AttributeType.STRING },
        sortKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
  
      // 13. DentiPal-OTPVerification
      const otpVerificationTable = new dynamodb.Table(this, 'OTPVerificationTable', {
        tableName: 'DentiPal-V5-OTPVerification',
        partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
  
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


    // Collect all tables for the main REST handler
    const allTables = [
      clinicProfilesTable, clinicFavoritesTable, clinicsTable, connectionsTable,
      conversationsTable, feedbackTable, jobApplicationsTable, jobInvitationsTable,
      jobNegotiationsTable, jobPostingsTable, messagesTable, notificationsTable,
      otpVerificationTable, professionalProfilesTable, referralsTable, userAddressesTable,
      userClinicAssignmentsTable
    ];

    // ========================================================================
    // S3 Buckets for file storage (profile images, certificates, video resumes)
    // ========================================================================
    // Buckets are created without explicit physical names so CDK will generate
    // unique names. Use RemovalPolicy.RETAIN to avoid accidental data loss.
    const profileImagesBucket = new s3.Bucket(this, 'ProfileImagesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const certificatesBucket = new s3.Bucket(this, 'CertificatesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const videoResumesBucket = new s3.Bucket(this, 'VideoResumesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Additional buckets requested: professional resumes and driving licenses,
    // and a dedicated bucket for professional licenses (mapped to CERTIFICATES_BUCKET)
    const professionalResumesBucket = new s3.Bucket(this, 'ProfessionalResumesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const drivingLicensesBucket = new s3.Bucket(this, 'DrivingLicensesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const professionalLicensesBucket = new s3.Bucket(this, 'ProfessionalLicensesBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
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
        SES_FROM: 'sreevidya.alluri@gmail.com', // Updated per your env variables
        SES_REGION: this.region,
        SES_TO: 'shashitest2004@gmail.com',     // Updated per your env variables
        SMS_TOPIC_ARN: `arn:aws:sns:${this.region}:${this.account}:DentiPal-SMS-Notifications`, // Dynamic construction
        FRONTEND_ORIGIN: 'http://localhost:5173',
        
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
        NOTIFICATIONS_TABLE: notificationsTable.tableName,
        OTP_VERIFICATION_TABLE: otpVerificationTable.tableName,
        PROFESSIONAL_PROFILES_TABLE: professionalProfilesTable.tableName,
        REFERRALS_TABLE: referralsTable.tableName,
        USER_ADDRESSES_TABLE: userAddressesTable.tableName,
        USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,

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
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
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
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminSetUserPassword',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:DeleteUser',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminListGroupsForUser'
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

    // ========================================================================
    // 5. REST API Gateway
    // ========================================================================

    const api = new apigateway.RestApi(this, 'DentiPalApi', {
      restApiName: 'DentiPal API',
      description: 'Backend API for DentiPal',
      deployOptions: { 
          stageName: 'prod',
          tracingEnabled: true,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Amz-Date', 'X-Api-Key', 'X-Amz-Security-Token'],
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
    // 6. WebSocket API & Handler (New Chat Module)
    // ========================================================================

    const webSocketChatHandler = new lambda.Function(this, 'WebSocketChatHandler', {
        functionName: 'DentiPal-Chat-WebSocket',
        runtime: lambda.Runtime.NODEJS_18_X,
        handler: 'dist/websocketHandler.handler', // Assumes bundling puts it in 'dist'
        code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
        environment: {
            REGION: this.region,
            USER_POOL_ID: userPool.userPoolId,
            MESSAGES_TABLE: messagesTable.tableName, // DentiPal-Messages
            CONNS_TABLE: connectionsTable.tableName,   // DentiPal-Connections
            CONVOS_TABLE: conversationsTable.tableName, // DentiPal-Conversations
        },
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
    });

    // --- WebSocket IAM Role Permissions ---

    // 1. DynamoDB Permissions for Chat Tables
    chatTables.forEach(table => {
        table.grantReadWriteData(webSocketChatHandler);
    });

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

    new apigwv2.WebSocketStage(this, 'DentiPalChatStage', {
        webSocketApi,
        stageName: 'prod', // Match your REST API stage name
        autoDeploy: true,
    });

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