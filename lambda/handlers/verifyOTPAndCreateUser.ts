import { 
    CognitoIdentityProviderClient, 
    ConfirmSignUpCommand, 
    AdminGetUserCommand,
    ConfirmSignUpCommandInput,
    AdminGetUserCommandInput,
    AdminGetUserCommandOutput
} from "@aws-sdk/client-cognito-identity-provider";
import { 
    SESClient, 
    SendEmailCommand, 
    SendEmailCommandInput
} from "@aws-sdk/client-ses";
import { 
    SNSClient, 
    PublishCommand, 
    PublishCommandInput
} from "@aws-sdk/client-sns";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const USER_POOL_ID: string = process.env.USER_POOL_ID!;
const CLIENT_ID: string = process.env.CLIENT_ID!;
const FROM_EMAIL: string = process.env.FROM_EMAIL || 'noreply@dentipal.com';
const SMS_TOPIC_ARN: string | undefined = process.env.SMS_TOPIC_ARN;
const SES_REGION: string = process.env.SES_REGION || REGION;

const cognito: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({ region: REGION });
const ses: SESClient = new SESClient({ region: SES_REGION });
const sns: SNSClient = new SNSClient({ region: REGION });

// --- 2. Type Definitions ---

/** Interface for the data expected in the request body for verification. */
interface VerifyRequestBody {
    email: string;
    confirmationCode: string;
}

/** Interface for the structured email content. */
interface EmailContent {
    subject: string;
    htmlBody: string;
    textBody: string;
}

/** Interface for a simplified Cognito user attribute structure. */
interface CognitoAttribute {
    Name?: string;
    Value?: string;
}

// --- 3. Utility Function: Email Template ---

/**
 * Creates the congratulations email template content.
 * @param fullName - The user's full name.
 * @param userType - The user's type ('professional' or 'clinic').
 * @returns An EmailContent object.
 */
function createCongratulationsEmail(fullName: string, userType: string): EmailContent {
    const subject: string = "🎉 Welcome to DentiPal - Registration Complete!";
    
    // Logic for feature list inside the HTML template
    const featureListHtml: string = userType === 'professional' ? `
        <div class="feature-item">✅ Complete your professional profile</div>
        <div class="feature-item">🔍 Browse available job opportunities</div>
        <div class="feature-item">📧 Get notified about relevant positions</div>
        <div class="feature-item">💬 Connect with dental clinics</div>
        <div class="feature-item">👥 Refer friends and earn rewards</div>
    ` : `
        <div class="feature-item">✅ Set up your clinic profile</div>
        <div class="feature-item">📝 Post job opportunities</div>
        <div class="feature-item">👤 Find qualified professionals</div>
        <div class="feature-item">⭐ Build your favorite professionals list</div>
        <div class="feature-item">📊 Manage your hiring workflow</div>
    `;

    const htmlBody: string = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f0f9ff; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 32px; font-weight: bold; color: #2563eb; margin-bottom: 15px; }
        .success-icon { font-size: 48px; margin-bottom: 20px; }
        .welcome-box { background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 25px; border-radius: 10px; text-align: center; margin: 25px 0; }
        .feature-list { background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .feature-item { margin: 10px 0; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
        .cta-button { display: inline-block; background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🦷 DentiPal</div>
          <div class="success-icon">🎉</div>
          <h1>Welcome to DentiPal!</h1>
        </div>
        
        <div class="welcome-box">
          <h2>Congratulations, ${fullName}!</h2>
          <p>Your ${userType === 'professional' ? 'professional' : 'clinic'} account has been successfully created and verified.</p>
        </div>
        
        <p>You're now part of the **DentiPal** community - the premier platform connecting dental professionals with opportunities!</p>
        
        <div class="feature-list">
          <h3>🚀 What's Next?</h3>
          ${featureListHtml}
        </div>
        
        <div style="text-align: center;">
          <a href="https://app.dentipal.com/login" class="cta-button">Get Started Now</a>
        </div>
        
        <div class="footer">
          <p>Need help? Contact our support team at support@dentipal.com</p>
          <p>Follow us on social media for tips and updates!</p>
          <p>© 2024 DentiPal. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
    `;
    
    // Text template structure
    const featureListText: string = userType === 'professional' ? `
What's Next:
✅ Complete your professional profile
🔍 Browse available job opportunities 
📧 Get notified about relevant positions
💬 Connect with dental clinics
👥 Refer friends and earn rewards
` : `
What's Next:
✅ Set up your clinic profile
📝 Post job opportunities
👤 Find qualified professionals
⭐ Build your favorite professionals list
📊 Manage your hiring workflow
`;

    const textBody: string = `
🎉 Welcome to DentiPal!

Congratulations, ${fullName}!

Your ${userType === 'professional' ? 'professional' : 'clinic'} account has been successfully created and verified.

You're now part of the DentiPal community - the premier platform connecting dental professionals with opportunities!

${featureListText}

Get started: https://app.dentipal.com/login

Need help? Contact support@dentipal.com

Welcome to the future of dental staffing!
    `;
    
    return { subject, htmlBody, textBody };
}

// --- 4. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('📥 Received event:', JSON.stringify(event, null, 2));
    
    // ❌ REMOVED INLINE CORS DEFINITION
    /*
    // Pre-define CORS headers for all responses
    const responseHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    */

    if (event.httpMethod === "OPTIONS") {
        // ✅ Uses imported headers
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }
    
    try {
        // Enhanced request body parsing
        let verifyData: VerifyRequestBody;
        try {
            verifyData = JSON.parse(event.body || '{}');
            if (typeof verifyData.email !== 'string' || typeof verifyData.confirmationCode !== 'string') {
                 throw new Error("Invalid request body structure");
            }
        } catch (parseError) {
            console.error('❌ Failed to parse request body:', parseError);
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "Invalid JSON or missing fields in request body",
                    success: false
                })
            };
        }

        console.log('📋 Parsed verification data:', verifyData);

        // Enhanced validation
        if (!verifyData.email || !verifyData.confirmationCode) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "Required fields: email, confirmationCode",
                    success: false
                })
            };
        }

        const email: string = verifyData.email.toLowerCase().trim();
        const confirmationCode: string = verifyData.confirmationCode.trim();

        // Step 1: Confirm signup with Cognito
        const confirmSignUpParams: ConfirmSignUpCommandInput = {
            ClientId: CLIENT_ID,
            Username: email,
            ConfirmationCode: confirmationCode,
        };

        console.log('🚀 Sending confirmation to Cognito...');
        
        try {
            await cognito.send(new ConfirmSignUpCommand(confirmSignUpParams));
            console.log('✅ Cognito confirmation successful.');
        } catch (confirmError) {
            console.error('❌ Cognito confirmation failed:', confirmError);
            
            const err = confirmError as { name: string, message: string };
            let errorMessage: string = "Verification failed. Please try again.";
            let statusCode: number = 400;

            if (err.name === 'CodeMismatchException') {
                errorMessage = "Invalid verification code. Please check the code and try again.";
            } else if (err.name === 'ExpiredCodeException') {
                errorMessage = "Verification code has expired. Please request a new one.";
            } else if (err.name === 'UserNotFoundException') {
                errorMessage = "User not found. Please check your email address.";
                statusCode = 404;
            } else if (err.name === 'NotAuthorizedException') {
                errorMessage = "User is already confirmed or invalid credentials.";
                statusCode = 403;
            } else if (err.name === 'LimitExceededException' || err.name === 'TooManyFailedAttemptsException') {
                errorMessage = "Too many attempts. Please wait before trying again.";
                statusCode = 429;
            } else {
                statusCode = 500;
                errorMessage = `Server Error: ${err.message}`;
            }

            return {
                statusCode,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: errorMessage,
                    success: false,
                    errorType: err.name
                })
            };
        }

        // Step 2: Get user details from Cognito (needed for welcome email)
        console.log('🔍 Fetching user details from Cognito...');
        const getUserParams: AdminGetUserCommandInput = {
            UserPoolId: USER_POOL_ID,
            Username: email,
        };

        let userResponse: AdminGetUserCommandOutput | undefined;
        try {
            userResponse = await cognito.send(new AdminGetUserCommand(getUserParams));
        } catch (getUserError) {
            console.error('❌ Failed to get user details:', getUserError);
            // This is non-critical if the confirmation succeeded, use fallbacks
        }

        const userAttributes: CognitoAttribute[] = userResponse?.UserAttributes || [];
        
        // Extract user details with fallbacks
        const fullName: string = (() => {
            const givenName = userAttributes.find(attr => attr.Name === 'given_name')?.Value || '';
            const familyName = userAttributes.find(attr => attr.Name === 'family_name')?.Value || '';
            const result = `${givenName} ${familyName}`.trim();
            return result || 'User';
        })();

        const addressField: string = userAttributes.find(attr => attr.Name === 'address')?.Value || '';
        const userType: string = (() => {
            const match = addressField.match(/userType:([^|]+)/);
            const extracted = match ? match[1] : 'professional';
            return extracted;
        })();

        const phoneNumber: string | undefined = userAttributes.find(attr => attr.Name === 'phone_number')?.Value;
        // Cognito sub is the PK, but Username is sufficient here
        const userSub: string = userResponse?.Username || email; 

        console.log('👤 User profile summary:', { fullName, userType, phoneNumber: !!phoneNumber, userSub });

        // Step 3: Send congratulations email
        console.log('📧 Preparing congratulations email...');
        const emailTemplate: EmailContent = createCongratulationsEmail(fullName, userType);
        
        const congratsEmailParams: SendEmailCommandInput = {
            Source: FROM_EMAIL,
            Destination: { ToAddresses: [email] },
            Message: {
                Subject: { Data: emailTemplate.subject, Charset: 'UTF-8' },
                Body: {
                    Html: { Data: emailTemplate.htmlBody, Charset: 'UTF-8' },
                    Text: { Data: emailTemplate.textBody, Charset: 'UTF-8' }
                }
            }
        };

        let emailSent: boolean = false;
        try {
            await ses.send(new SendEmailCommand(congratsEmailParams));
            console.log('✅ Welcome email sent successfully.');
            emailSent = true;
        } catch (emailError) {
            console.error('⚠️ Failed to send welcome email (non-critical):', emailError);
        }

        // Step 4: Send congratulations SMS if phone number provided
        let smsSent: boolean = false;
        if (phoneNumber && SMS_TOPIC_ARN) {
            console.log('📱 Sending welcome SMS...');
            const smsMessage: string = `🎉 Welcome to DentiPal, ${fullName}! Your ${userType} account is ready. Start exploring opportunities at app.dentipal.com`;
            
            const smsCommandParams: PublishCommandInput = {
                TopicArn: SMS_TOPIC_ARN,
                Message: smsMessage,
                Subject: 'Welcome to DentiPal!'
            };

            try {
                await sns.send(new PublishCommand(smsCommandParams));
                console.log('✅ Welcome SMS sent successfully.');
                smsSent = true;
            } catch (smsError) {
                console.error('⚠️ Failed to send welcome SMS (non-critical):', smsError);
            }
        } else {
            console.log('📱 Skipping SMS - no phone number or SMS_TOPIC_ARN not configured');
        }

        // Step 5: Return success response
        const successResponse = {
            message: "Email verification completed successfully! Welcome to DentiPal!",
            success: true,
            isVerified: true,
            status: "VERIFIED",
            userSub,
            email,
            fullName,
            userType,
            welcomeMessageSent: emailSent,
            smsSent,
            nextSteps: userType === 'professional' ?
                "Complete your professional profile to start receiving job opportunities" :
                "Set up your clinic profile and start posting job opportunities",
            timestamp: new Date().toISOString()
        };

        console.log('✅ Verification completed successfully.');

        return {
            statusCode: 201,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify(successResponse)
        };

    } catch (error) {
        console.error("💥 Unexpected error in verification handler:", error);
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                error: "Internal server error during verification",
                success: false,
                message: "An unexpected error occurred. Please try again or contact support.",
                timestamp: new Date().toISOString()
            })
        };
    }
};