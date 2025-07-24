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

    // Cognito User Pool
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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cognito App Client
    const client = userPool.addClient('ClinicAppClient', {
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
    });

    // Cognito Groups
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
      new cognito.CfnUserPoolGroup(this, `Group${group.replace(/[:/]/g, '')}`, {
        userPoolId: userPool.userPoolId,
        groupName: group,
      });
    });

    // DynamoDB Tables
    const clinicsTable = new dynamodb.Table(this, 'ClinicsTable', {
      tableName: 'Clinics',
      partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const jobPostingsTable = new dynamodb.Table(this, 'JobPostingsTable', {
      tableName: 'JobPostings',
      partitionKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'postingId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const userClinicAssignmentsTable = new dynamodb.Table(this, 'UserClinicAssignmentsTable', {
      tableName: 'UserClinicAssignments',
      partitionKey: { name: 'userSub', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'clinicId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Lambda Function
    const lambdaFunction = new lambda.Function(this, 'ClinicManagementFunction', {
      functionName: 'ClinicManagementFunction',
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
        CLINICS_TABLE: clinicsTable.tableName,
        JOB_POSTINGS_TABLE: jobPostingsTable.tableName,
        USER_CLINIC_ASSIGNMENTS_TABLE: userClinicAssignmentsTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    // IAM Role Permissions
    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cognito-idp:SignUp',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminGetUser',
        'cognito-idp:AdminUpdateUserAttributes',
        'cognito-idp:AdminDeleteUser',
        'cognito-idp:DeleteUser',
      ],
      resources: [userPool.userPoolArn],
    }));

    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'dynamodb:PutItem',
        'dynamodb:GetItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan',
      ],
      resources: [
        clinicsTable.tableArn,
        jobPostingsTable.tableArn,
        userClinicAssignmentsTable.tableArn,
      ],
    }));

    lambdaFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    }));

    // API Gateway
    const api = new apigateway.RestApi(this, 'ClinicManagementApi', {
      restApiName: 'Clinic Management API',
      deployOptions: { stageName: 'prod' },
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Cognito Authorizer
    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
    });

    // API Endpoints
    const endpoints = [
      'create-user',
      'get-user',
      'update-user',
      'delete-user',
      'delete-own-account',
      'create-clinic',
      'get-clinic',
      'update-clinic',
      'delete-clinic',
      'create-assignment',
      'get-assignments',
      'update-assignment',
      'delete-assignment',
      'get-job-postings',
    ];

    endpoints.forEach(endpoint => {
      const resource = api.root.addResource(endpoint);
      resource.addMethod('POST', new apigateway.LambdaIntegration(lambdaFunction), {
        authorizer,
        authorizationType: apigateway.AuthorizationType.COGNITO,
      });
    });

    // Outputs
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId, description: 'Cognito User Pool ID' });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId, description: 'Cognito App Client ID' });
    new cdk.CfnOutput(this, 'ApiEndpoint', { value: api.url, description: 'API Gateway Endpoint' });
  }
}