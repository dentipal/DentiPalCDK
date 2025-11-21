import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class DentiPalCDKStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ========================================================================
    // 1. Cognito User Pool
    // ========================================================================
    const userPool = new cognito.UserPool(this, 'ClinicUserPool', {
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

    const client = userPool.addClient('ClinicAppClient', {
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
    });

    const groups = [
      'Root',
      'Clinic Employees:ClinicAdmin',
      'Clinic Employees:ClinicManager',
      'Clinic Employees:ClinicViewer',
      'Professionals:Front Desk',
      'Professionals:Dental Assistant',
      'Professionals:Front Desk/DA',
      'Professionals:Hygienist',
      'Professionals:Dentist',
    ];

    groups.forEach(group => {
      new cognito.CfnUserPoolGroup(this, `Group${group.replace(/[:/ ]/g, '')}`, {
        userPoolId: userPool.userPoolId,
        groupName: group,
      });
    });

    // ========================================================================
    // 2. DynamoDB Tables & GSIs
    // ========================================================================

    // 1. DentiPal-Clinic-Profiles
    const clinicProfilesTable = new dynamodb.Table(this, 'ClinicProfilesTable', {
      tableName: 'DentiPal-Clinic-Profiles',
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
      tableName: 'DentiPal-ClinicFavorites',
      partitionKey: { name: 'clinicUserSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'professionalUserSub', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 3. DentiPal-Clinics
    const clinicsTable = new dynamodb.Table(this, 'ClinicsTable', {
      tableName: 'DentiPal-Clinics',
      partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    clinicsTable.addGlobalSecondaryIndex({
      indexName: 'CreatedByIndex',
      partitionKey: { name: 'createdBy', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 4. DentiPal-Connections
    const connectionsTable = new dynamodb.Table(this, 'ConnectionsTable', {
      tableName: 'DentiPal-Connections',
      partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'clinicKey-index',
      partitionKey: { name: 'clinicKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'connectionId-index',
      partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'profKey-index',
      partitionKey: { name: 'profKey', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    connectionsTable.addGlobalSecondaryIndex({
      indexName: 'UserKeyIndex',
      partitionKey: { name: 'userKey', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 5. DentiPal-Conversations
    const conversationsTable = new dynamodb.Table(this, 'ConversationsTable', {
      tableName: 'DentiPal-Conversations',
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
      tableName: 'DentiPal-Feedback',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 7. DentiPal-JobApplications
    const jobApplicationsTable = new dynamodb.Table(this, 'JobApplicationsTable', {
      tableName: 'DentiPal-JobApplications',
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
    jobApplicationsTable.addGlobalSecondaryIndex({
      indexName: 'JobIdIndex',
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
      tableName: 'DentiPal-JobInvitations',
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
      tableName: 'DentiPal-JobNegotiations',
      partitionKey: { name: 'applicationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'negotiationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    jobNegotiationsTable.addGlobalSecondaryIndex({
      indexName: 'index',
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
      tableName: 'DentiPal-JobPostings',
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
    jobPostingsTable.addGlobalSecondaryIndex({
      indexName: 'jobId-index',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    jobPostingsTable.addGlobalSecondaryIndex({
      indexName: 'JobIdIndex',
      partitionKey: { name: 'jobId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // 11. DentiPal-Messages
    const messagesTable = new dynamodb.Table(this, 'MessagesTable', {
      tableName: 'DentiPal-Messages',
      partitionKey: { name: 'conversationId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
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
      tableName: 'DentiPal-Notifications',
      partitionKey: { name: 'recipientUserSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'notificationId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 13. DentiPal-OTPVerification
    const otpVerificationTable = new dynamodb.Table(this, 'OTPVerificationTable', {
      tableName: 'DentiPal-OTPVerification',
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 14. DentiPal-ProfessionalProfiles
    const professionalProfilesTable = new dynamodb.Table(this, 'ProfessionalProfilesTable', {
      tableName: 'DentiPal-ProfessionalProfiles',
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 15. DentiPal-Referrals
    const referralsTable = new dynamodb.Table(this, 'ReferralsTable', {
      tableName: 'DentiPal-Referrals',
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
      tableName: 'DentiPal-UserAddresses',
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 17. DentiPal-UserClinicAssignments
    const userClinicAssignmentsTable = new dynamodb.Table(this, 'UserClinicAssignmentsTable', {
      tableName: 'DentiPal-UserClinicAssignments',
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });


    // ========================================================================
    // 3. Lambda Function
    // ========================================================================
    
    const lambdaFunction = new lambda.Function(this, 'ClinicManagementFunction', {
      functionName: 'DentiPal-Backend-Monolith',
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda'), {
        bundling: {
          command: [
            'bash', '-c',
            'npm install && npm run build && cp -r dist/* /asset-output/ && cp -r node_modules /asset-output/'
          ],
          image: lambda.Runtime.NODEJS_18_X.bundlingImage,
          user: 'root',
        },
      }),
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
      },
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
    });

    // ========================================================================
    // 4. IAM Role Permissions
    // ========================================================================

    // DynamoDB Permissions (Granting Full Access for CRUD operations)
    const allTables = [
      clinicProfilesTable, clinicFavoritesTable, clinicsTable, connectionsTable,
      conversationsTable, feedbackTable, jobApplicationsTable, jobInvitationsTable,
      jobNegotiationsTable, jobPostingsTable, messagesTable, notificationsTable,
      otpVerificationTable, professionalProfilesTable, referralsTable, userAddressesTable,
      userClinicAssignmentsTable
    ];

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

    // ========================================================================
    // 5. API Gateway
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

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      resultsCacheTtl: cdk.Duration.seconds(0),
    });

    // --- Monolith Proxy Resource ---
    // Catch-all route to route everything to the Lambda
    api.root.addProxy({
      defaultIntegration: new apigateway.LambdaIntegration(lambdaFunction),
      // We remove the default authorizer here to let the Lambda code handle auth logic (public vs private)
      // via extractUserFromBearerToken, matching your code's logic.
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.NONE, 
      }
    });

    // ========================================================================
    // 6. Outputs
    // ========================================================================
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.url });
  }
}