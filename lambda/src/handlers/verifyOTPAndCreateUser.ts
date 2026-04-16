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
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

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
    const subject: string = "Welcome to DentiPal - Registration Complete!";
    const isProfessional = userType === 'professional';
    const accountLabel = isProfessional ? 'Professional' : 'Clinic';

    const features = isProfessional ? [
        { icon: "1", text: "Complete your professional profile" },
        { icon: "2", text: "Browse available job opportunities" },
        { icon: "3", text: "Get notified about relevant positions" },
        { icon: "4", text: "Connect with dental clinics" },
        { icon: "5", text: "Refer friends and earn rewards" },
    ] : [
        { icon: "1", text: "Set up your clinic profile" },
        { icon: "2", text: "Post job opportunities" },
        { icon: "3", text: "Find qualified dental professionals" },
        { icon: "4", text: "Build your favorite professionals list" },
        { icon: "5", text: "Manage your hiring workflow" },
    ];

    const featureRowsHtml = features.map(f => `
              <tr>
                <td style="width:36px;padding:10px 0;">
                  <div style="width:28px;height:28px;border-radius:50%;background:#f8ccc1;color:#532b21;font-size:13px;font-weight:700;text-align:center;line-height:28px;">${f.icon}</div>
                </td>
                <td style="padding:10px 0 10px 12px;font-size:15px;color:#333;border-bottom:1px solid #fde8e4;">${f.text}</td>
              </tr>`).join("");

    const htmlBody: string = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background-color:#fff0f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff0f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);padding:40px;text-align:center;">
          <h1 style="margin:0;font-size:32px;color:#532b21;letter-spacing:0.5px;">DentiPal</h1>
          <p style="margin:8px 0 0;color:#7a4a3a;font-size:15px;">Connecting Dental Professionals</p>
        </td></tr>

        <!-- Welcome Banner -->
        <tr><td style="padding:32px 40px 0;text-align:center;">
          <div style="background:linear-gradient(135deg,#532b21 0%,#7a4a3a 100%);color:#fff;padding:28px 32px;border-radius:14px;">
            <p style="margin:0;font-size:14px;color:#f8ccc1;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Welcome</p>
            <h2 style="margin:8px 0 4px;font-size:24px;font-weight:700;">${fullName}</h2>
            <p style="margin:0;font-size:14px;color:#ddd;">Your ${accountLabel} account is verified and ready to go</p>
          </div>
        </td></tr>

        <!-- Success Message -->
        <tr><td style="padding:24px 40px;text-align:center;">
          <p style="margin:0;font-size:15px;color:#666;line-height:1.6;">
            You're now part of the DentiPal community &mdash; the premier platform connecting dental professionals with clinics.
          </p>
        </td></tr>

        <!-- What's Next -->
        <tr><td style="padding:0 40px 8px;">
          <p style="margin:0;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">What's Next</p>
        </td></tr>
        <tr><td style="padding:0 40px 24px;">
          <table width="100%" style="background:#fef7f5;border-radius:12px;padding:8px 20px;" cellpadding="0" cellspacing="0">
            ${featureRowsHtml}
          </table>
        </td></tr>

        <!-- CTA Button -->
        <tr><td style="padding:0 40px 32px;text-align:center;">
          <a href="https://app.dentipal.com/login" style="display:inline-block;background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);color:#532b21;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;letter-spacing:0.3px;">
            Get Started Now
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#fef7f5;padding:24px 40px;border-top:1px solid #fde8e4;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;color:#999;">Need help? Contact us at support@dentipal.com</p>
          <p style="margin:0;font-size:12px;color:#ccc;">DentiPal. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const featureListText = features.map((f, i) => `  ${i + 1}. ${f.text}`).join("\n");

    const textBody: string = `Welcome to DentiPal!

Congratulations, ${fullName}!

Your ${accountLabel} account has been successfully created and verified.

You're now part of the DentiPal community - the premier platform connecting dental professionals with clinics.

What's Next:
${featureListText}

Get started: https://app.dentipal.com/login

Need help? Contact support@dentipal.com
`;

    return { subject, htmlBody, textBody };
}

// --- 4. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    console.log('📥 Received event:', JSON.stringify(event, null, 2));
    
 
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
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Invalid JSON format in request body",
                    details: { issue: "Body must be valid JSON with email and confirmationCode" },
                    timestamp: new Date().toISOString()
                })
            };
        }

        console.log('📋 Parsed verification data:', verifyData);

        // Enhanced validation
        if (!verifyData.email || !verifyData.confirmationCode) {
            const missingFields = [
                !verifyData.email && "email",
                !verifyData.confirmationCode && "confirmationCode"
            ].filter(Boolean);

            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Required fields are missing",
                    details: { missingFields },
                    timestamp: new Date().toISOString()
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
            let errorMessage: string = "Verification failed";
            let errorName: string = "Bad Request";
            let statusCode: number = 400;
            let details: Record<string, any> = { errorType: err.name, reason: err.message };

            if (err.name === 'CodeMismatchException') {
                errorMessage = "Invalid verification code";
                details.suggestion = "Please check the code and try again";
            } else if (err.name === 'ExpiredCodeException') {
                errorMessage = "Verification code has expired";
                details.suggestion = "Please request a new code";
            } else if (err.name === 'UserNotFoundException') {
                errorMessage = "User not found";
                errorName = "Not Found";
                statusCode = 404;
                details.suggestion = "Please check your email address";
            } else if (err.name === 'NotAuthorizedException') {
                errorMessage = "User is already verified or invalid credentials";
                errorName = "Forbidden";
                statusCode = 403;
                details.suggestion = "If you've already verified, please proceed to login";
            } else if (err.name === 'LimitExceededException' || err.name === 'TooManyFailedAttemptsException') {
                errorMessage = "Too many attempts";
                errorName = "Too Many Requests";
                statusCode = 429;
                details.suggestion = "Please wait before trying again";
            } else {
                statusCode = 500;
                errorName = "Internal Server Error";
                errorMessage = "Verification failed";
            }

            return {
                statusCode,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: errorName,
                    statusCode: statusCode,
                    message: errorMessage,
                    details: details,
                    timestamp: new Date().toISOString()
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
            status: "success",
            statusCode: 201,
            message: "Email verification completed successfully!",
            data: {
                isVerified: true,
                userSub,
                email,
                fullName,
                userType,
                welcomeMessageSent: emailSent,
                smsSent,
                nextSteps: userType === 'professional' ?
                    "Complete your professional profile to start receiving job opportunities" :
                    "Set up your clinic profile and start posting job opportunities",
            },
            timestamp: new Date().toISOString()
        };

        console.log('✅ Verification completed successfully.');

        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify(successResponse)
        };

    } catch (error) {
        console.error("💥 Unexpected error in verification handler:", error);
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Internal Server Error",
                statusCode: 500,
                message: "An unexpected error occurred during verification",
                details: { reason: error instanceof Error ? error.message : "Unknown error" },
                suggestion: "Please try again or contact support",
                timestamp: new Date().toISOString()
            })
        };
    }
};