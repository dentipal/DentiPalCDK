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
import { corsHeaders } from "./corsHeaders";

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
    const subject: string = "Welcome to DentiPal";
    const isProfessional = userType === 'professional';
    const accountLabel = isProfessional ? 'professional' : 'clinic';
    const escapeForHtml = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
    const safeName = escapeForHtml(fullName);
    const fontStack = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const year = new Date().getFullYear();

    const features: Array<{ title: string; body: string }> = isProfessional ? [
        { title: "Complete your profile", body: "Upload your credentials and set your availability so clinics can find and evaluate you." },
        { title: "Browse available shifts", body: "Review real-time openings in your area, with hourly rates and clinic details displayed in advance." },
        { title: "Apply efficiently", body: "Your profile is submitted with every application, eliminating the need for repetitive paperwork." },
        { title: "Receive timely notifications", body: "Be informed promptly when clinics post roles that match your qualifications." },
        { title: "Participate in our referral program", body: "Invite qualified colleagues to the platform. Both parties receive rewards upon the completion of their first shift." },
    ] : [
        { title: "Configure your clinic profile", body: "Add your location, operating hours, and team details to give candidates a clear understanding of your practice." },
        { title: "Publish your first shift", body: "Specify the role, set the compensation, and publish — the process typically takes under a minute." },
        { title: "Discover qualified professionals", body: "Filter candidates by role, certifications, location, and availability." },
        { title: "Build a list of preferred professionals", body: "Maintain a shortlist of trusted professionals you wish to engage again." },
        { title: "Manage your hiring workflow", body: "Track applications, approvals, and shift history within a single, integrated workflow." },
    ];

    const featureRowsHtml = features.map((f, i) => {
        const isLast = i === features.length - 1;
        const border = isLast ? "" : "border-bottom:1px solid #e8e8ed;";
        return `<tr>
            <td valign="top" style="width:36px;padding:16px 0;${border}">
              <div style="width:28px;height:28px;border-radius:50%;background:#1d1d1f;color:#ffffff;font-size:13px;font-weight:600;text-align:center;line-height:28px;letter-spacing:-0.01em;">${i + 1}</div>
            </td>
            <td style="padding:16px 0 16px 14px;${border}">
              <p style="margin:0 0 4px;color:#1d1d1f;font-size:15px;font-weight:600;letter-spacing:-0.01em;">${escapeForHtml(f.title)}</p>
              <p style="margin:0;color:#6e6e73;font-size:14px;line-height:1.5;letter-spacing:-0.005em;">${escapeForHtml(f.body)}</p>
            </td>
          </tr>`;
    }).join("");

    const htmlBody: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>Welcome to DentiPal</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:${fontStack};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your DentiPal ${accountLabel} account is verified and ready to use.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
    <tr><td align="center" style="padding:48px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <tr><td style="padding:0 8px 18px;text-align:center;">
          <span style="display:inline-block;font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.02em;">DentiPal</span>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 40px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:44px 40px 32px;">

              <p style="margin:0 0 10px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Account verified</p>
              <h1 style="margin:0 0 14px;color:#1d1d1f;font-size:28px;font-weight:700;letter-spacing:-0.025em;line-height:1.15;">Welcome to DentiPal, ${safeName}</h1>
              <p style="margin:0 0 28px;color:#424245;font-size:16px;line-height:1.55;letter-spacing:-0.01em;">
                Your ${accountLabel} account has been successfully verified and is now active. You have joined a trusted network that connects dental professionals with the clinics that rely on their expertise.
              </p>

              <p style="margin:0 0 12px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Recommended next steps</p>
              <table cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;margin:0 0 28px;">
                <tr><td style="padding:0 22px;">
                  <table width="100%" cellpadding="0" cellspacing="0">${featureRowsHtml}</table>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td align="center">
                  <a href="https://dentipal.com/login" style="display:inline-block;background:#1d1d1f;color:#ffffff;padding:14px 32px;border-radius:980px;font-size:15px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;line-height:1;">Open DentiPal</a>
                </td></tr>
                <tr><td align="center" style="padding-top:14px;">
                  <p style="margin:0;color:#86868b;font-size:13px;letter-spacing:-0.005em;">Sign in using the email address provided during registration</p>
                </td></tr>
              </table>

              <div style="margin:32px 0 0;padding:18px 20px;background:rgba(245,245,247,0.7);border:1px solid rgba(0,0,0,0.04);border-radius:14px;">
                <p style="margin:0;color:#6e6e73;font-size:13px;line-height:1.55;letter-spacing:-0.005em;">
                  Require assistance getting started? Simply reply to this email and a member of our team will respond promptly.
                </p>
              </div>

            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px;text-align:center;">
          <p style="margin:0 0 10px;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            You are receiving this email because an account was recently created on DentiPal using this email address.
          </p>
          <p style="margin:18px 0 0;color:#a1a1a6;font-size:11px;letter-spacing:0.01em;">&copy; ${year} DentiPal</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const featureListText = features.map((f, i) => `  ${i + 1}. ${f.title} — ${f.body}`).join("\n");

    const textBody: string = `DentiPal

Welcome to DentiPal, ${fullName}

Your ${accountLabel} account has been successfully verified and is now active. You have joined a trusted network that connects dental professionals with the clinics that rely on their expertise.

Recommended next steps:
${featureListText}

Open DentiPal: https://dentipal.com/login

Require assistance getting started? Simply reply to this email and a member of our team will respond promptly.
`;

    return { subject, htmlBody, textBody };
}

// --- 4. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('📥 Received event:', JSON.stringify(event, null, 2));
    
 
    if (event.httpMethod === "OPTIONS") {
        // ✅ Uses imported headers
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
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
                headers: corsHeaders(event),
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
                headers: corsHeaders(event),
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
                headers: corsHeaders(event),
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
            const smsMessage: string = `🎉 Welcome to DentiPal, ${fullName}! Your ${userType} account is ready. Start exploring opportunities at dentipal.com`;
            
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
            headers: corsHeaders(event),
            body: JSON.stringify(successResponse)
        };

    } catch (error) {
        console.error("💥 Unexpected error in verification handler:", error);
        
        return {
            statusCode: 500,
            headers: corsHeaders(event),
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