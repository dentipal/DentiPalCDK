"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");
const client_ses_1 = require("@aws-sdk/client-ses");
const client_sns_1 = require("@aws-sdk/client-sns");

const cognito = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({ region: process.env.REGION });
const ses = new client_ses_1.SESClient({ region: process.env.SES_REGION });
const sns = new client_sns_1.SNSClient({ region: process.env.REGION });

// Create congratulations email template
function createCongratulationsEmail(fullName, userType) {
    const subject = "🎉 Welcome to DentiPal - Registration Complete!";
    const htmlBody = `
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
        
        <p>You're now part of the DentiPal community - the premier platform connecting dental professionals with opportunities!</p>
        
        <div class="feature-list">
          <h3>🚀 What's Next?</h3>
          ${userType === 'professional' ? `
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
          `}
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
    const textBody = `
🎉 Welcome to DentiPal!

Congratulations, ${fullName}!

Your ${userType === 'professional' ? 'professional' : 'clinic'} account has been successfully created and verified.

You're now part of the DentiPal community - the premier platform connecting dental professionals with opportunities!

${userType === 'professional' ? `
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
`}

Get started: https://app.dentipal.com/login

Need help? Contact support@dentipal.com

Welcome to the future of dental staffing!
  `;
    return { subject, htmlBody, textBody };
}

const handler = async (event) => {
    console.log('📥 Received event:', JSON.stringify(event, null, 2));
    
    try {
        // Enhanced request body parsing
        let verifyData;
        try {
            verifyData = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        } catch (parseError) {
            console.error('❌ Failed to parse request body:', parseError);
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                },
                body: JSON.stringify({
                    error: "Invalid JSON in request body",
                    success: false
                })
            };
        }

        console.log('📋 Parsed verification data:', verifyData);

        // Enhanced validation
        if (!verifyData.email || !verifyData.confirmationCode) {
            console.error('❌ Missing required fields:', { 
                email: !!verifyData.email, 
                confirmationCode: !!verifyData.confirmationCode 
            });
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                },
                body: JSON.stringify({
                    error: "Required fields: email, confirmationCode",
                    success: false
                })
            };
        }

        const email = verifyData.email.toLowerCase().trim();
        const confirmationCode = verifyData.confirmationCode.trim();

        console.log('🔍 Processing verification for:', { 
            email, 
            codeLength: confirmationCode.length,
            clientId: process.env.CLIENT_ID ? 'present' : 'missing',
            userPoolId: process.env.USER_POOL_ID ? 'present' : 'missing'
        });

        // Step 1: Confirm signup with Cognito
        const confirmSignUpCommand = new client_cognito_identity_provider_1.ConfirmSignUpCommand({
            ClientId: process.env.CLIENT_ID,
            Username: email,
            ConfirmationCode: confirmationCode,
        });

        console.log('🚀 Sending confirmation to Cognito...');
        
        try {
            const confirmResult = await cognito.send(confirmSignUpCommand);
            console.log('✅ Cognito confirmation successful:', confirmResult);
        } catch (confirmError) {
            console.error('❌ Cognito confirmation failed:', confirmError);
            
            // Enhanced error handling for specific Cognito errors
            let errorMessage = "Verification failed. Please try again.";
            let statusCode = 400;

            if (confirmError.name === 'CodeMismatchException') {
                errorMessage = "Invalid verification code. Please check the code and try again.";
            } else if (confirmError.name === 'ExpiredCodeException') {
                errorMessage = "Verification code has expired. Please request a new one.";
            } else if (confirmError.name === 'UserNotFoundException') {
                errorMessage = "User not found. Please check your email address.";
                statusCode = 404;
            } else if (confirmError.name === 'NotAuthorizedException') {
                errorMessage = "User is already confirmed or invalid credentials.";
                statusCode = 403;
            } else if (confirmError.name === 'LimitExceededException') {
                errorMessage = "Too many attempts. Please wait before trying again.";
                statusCode = 429;
            } else if (confirmError.name === 'TooManyFailedAttemptsException') {
                errorMessage = "Too many failed attempts. Please wait before trying again.";
                statusCode = 429;
            }

            return {
                statusCode,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                },
                body: JSON.stringify({
                    error: errorMessage,
                    success: false,
                    errorType: confirmError.name
                })
            };
        }

        // Step 2: Get user details from Cognito
        console.log('🔍 Fetching user details from Cognito...');
        const getUserCommand = new client_cognito_identity_provider_1.AdminGetUserCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
        });

        let userResponse;
        try {
            userResponse = await cognito.send(getUserCommand);
            console.log('✅ User details retrieved:', { 
                username: userResponse.Username,
                userStatus: userResponse.UserStatus,
                attributesCount: userResponse.UserAttributes?.length || 0
            });
        } catch (getUserError) {
            console.error('❌ Failed to get user details:', getUserError);
            // Continue anyway, we have the basic verification
        }

        const userAttributes = userResponse?.UserAttributes || [];
        console.log('📋 User attributes:', userAttributes.map(attr => ({ name: attr.Name, hasValue: !!attr.Value })));

        // Extract user details with better error handling
        const fullName = (() => {
            const givenName = userAttributes.find(attr => attr.Name === 'given_name')?.Value || '';
            const familyName = userAttributes.find(attr => attr.Name === 'family_name')?.Value || '';
            const result = `${givenName} ${familyName}`.trim();
            return result || 'User'; // Fallback name
        })();

        // Parse userType from address field (temporary solution)
        const addressField = userAttributes.find(attr => attr.Name === 'address')?.Value || '';
        const userType = (() => {
            const match = addressField.match(/userType:([^|]+)/);
            const extracted = match ? match[1] : 'professional';
            console.log('🏷️ Extracted userType:', extracted, 'from address:', addressField);
            return extracted;
        })();

        const phoneNumber = userAttributes.find(attr => attr.Name === 'phone_number')?.Value;
        const userSub = userResponse?.Username || email;

        console.log('👤 User profile summary:', { fullName, userType, phoneNumber: !!phoneNumber, userSub });

        // Step 3: Send congratulations email
        console.log('📧 Preparing congratulations email...');
        const emailTemplate = createCongratulationsEmail(fullName, userType);
        const congratsEmailCommand = new client_ses_1.SendEmailCommand({
            Source: process.env.FROM_EMAIL || 'noreply@dentipal.com',
            Destination: {
                ToAddresses: [email]
            },
            Message: {
                Subject: {
                    Data: emailTemplate.subject,
                    Charset: 'UTF-8'
                },
                Body: {
                    Html: {
                        Data: emailTemplate.htmlBody,
                        Charset: 'UTF-8'
                    },
                    Text: {
                        Data: emailTemplate.textBody,
                        Charset: 'UTF-8'
                    }
                }
            }
        });

        let emailSent = false;
        try {
            const emailResult = await ses.send(congratsEmailCommand);
            console.log('✅ Welcome email sent successfully:', emailResult.MessageId);
            emailSent = true;
        } catch (emailError) {
            console.error('⚠️ Failed to send welcome email (non-critical):', emailError);
            // Don't fail the entire registration for email issues
        }

        // Step 4: Send congratulations SMS if phone number provided
        let smsSent = false;
        if (phoneNumber && process.env.SMS_TOPIC_ARN) {
            console.log('📱 Sending welcome SMS...');
            const smsMessage = `🎉 Welcome to DentiPal, ${fullName}! Your ${userType} account is ready. Start exploring opportunities at app.dentipal.com`;
            const smsCommand = new client_sns_1.PublishCommand({
                TopicArn: process.env.SMS_TOPIC_ARN,
                Message: smsMessage,
                Subject: 'Welcome to DentiPal!'
            });

            try {
                const smsResult = await sns.send(smsCommand);
                console.log('✅ Welcome SMS sent successfully:', smsResult.MessageId);
                smsSent = true;
            } catch (smsError) {
                console.error('⚠️ Failed to send welcome SMS (non-critical):', smsError);
                // Don't fail the registration for SMS issues
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

        console.log('✅ Verification completed successfully:', successResponse);

        return {
            statusCode: 201,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
            body: JSON.stringify(successResponse)
        };

    } catch (error) {
        console.error("💥 Unexpected error in verification handler:", error);
        
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
            body: JSON.stringify({
                error: "Internal server error during verification",
                success: false,
                message: "An unexpected error occurred. Please try again or contact support.",
                timestamp: new Date().toISOString()
            })
        };
    }
};

exports.handler = handler;