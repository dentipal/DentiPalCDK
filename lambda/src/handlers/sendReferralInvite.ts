import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    AttributeValue,
    DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
    SendEmailCommand,
    SESClient,
    SESClientConfig,
    SendEmailCommandInput,
} from "@aws-sdk/client-ses";
import {
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    APIGatewayProxyEvent,
} from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils"; 
import { CORS_HEADERS } from "./corsHeaders";
// --- Type Definitions ---

type DynamoDBItem = { [key: string]: AttributeValue | undefined };
type HandlerResponse = APIGatewayProxyResultV2; // Using V2 for modern API Gateway

/** Defines the expected structure of the request body payload. */
interface ReferralPayload {
    friendEmail: string;
    personalMessage?: string;
}

/** Defines the expected structure of a professional profile item for the referrer. */
interface ProfileItem extends DynamoDBItem {
    userSub?: AttributeValue;
    full_name?: AttributeValue;
}

/** Defines the return structure for the email template function. */
interface EmailTemplate {
    subject: string;
    htmlBody: string;
    textBody: string;
}

// --- Initialization ---

// Use non-null assertion (!) as we expect these environment variables to be set.
const REGION: string = process.env.REGION!;
const SES_REGION: string = process.env.SES_REGION!;
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
const REFERRALS_TABLE: string = process.env.REFERRALS_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);
const ses = new SESClient({ region: SES_REGION } as SESClientConfig);

// Get CORS Origin from environment variable or default to localhost


// --- Email Template Function ---

/**
 * Creates the HTML and text bodies for the referral email.
 */
function createReferralEmail(
    referrerName: string, 
    friendEmail: string, 
    personalMessage: string | undefined, 
    referrerUserSub: string
): EmailTemplate {
    const subject = `${referrerName} invites you to join DentiPal! 🦷`;
    const signupUrl = `http://localhost:5173/professional-signup?ref=${referrerUserSub}`;
    
    // HTML Body (long string for email content)
    const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f0f9ff; }
        .container { max-width: 600px; margin: 0 auto; background-color: white; padding: 40px; border-radius: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 32px; font-weight: bold; color: #2563eb; margin-bottom: 15px; }
        .invite-icon { font-size: 48px; margin-bottom: 20px; }
        .invite-box { background: linear-gradient(135deg, #D4E3F2 0%, #f8f8f8 100%); color: #000000; padding: 25px; border-radius: 10px; text-align: center; margin: 25px 0; }
        .personal-message { background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 20px; margin: 20px 0; font-style: italic; }
        .benefits-list { background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; }
        .benefit-item { margin: 10px 0; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
        .cta-button { display: inline-block; background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="logo">🦷 DentiPal</div>
          <div class="invite-icon">👋</div>
          <h1>You're Invited!</h1>
        </div>
        
        <div class="invite-box">
          <h2>Hi ${friendEmail}!</h2>
          <p><strong>${referrerName}</strong> thinks you'd love DentiPal - the premier platform for dental professionals!</p>
        </div>
        
        ${personalMessage ? 
          `<div class="personal-message">
            <strong>Personal message from ${referrerName}:</strong><br>
            "${personalMessage}"
          </div>` 
        : ''}
        
        <p>DentiPal connects dental professionals with amazing career opportunities. Whether you're looking for temporary shifts, consulting projects, or permanent positions, we've got you covered!</p>
        
        <div class="benefits-list">
          <h3>🌟 Why Join DentiPal?</h3>
          <div class="benefit-item">💼 Access to exclusive job opportunities</div>
          <div class="benefit-item">⚡ Fast and easy application process</div>
          <div class="benefit-item">💰 Competitive compensation</div>
          <div class="benefit-item">🤝 Direct connection with dental clinics</div>
          <div class="benefit-item">📱 User-friendly mobile platform</div>
          <div class="benefit-item">🎯 Personalized job matching</div>
        </div>
        
        <div style="text-align: center;">
          <a href="${signupUrl}" class="cta-button">Join DentiPal Now - It's Free!</a>
        </div>
        
        <p style="text-align: center; margin-top: 20px;">
          <small>By joining through this referral, both you and ${referrerName} may be eligible for special bonuses!</small>
        </p>
        
        <div class="footer">
          <p>Join thousands of dental professionals who trust DentiPal for their career growth.</p>
          <p>Questions? Contact us at support@dentipal.com</p>
          <p>© 2024 DentiPal. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
    `;

    // Text Body
    const textBody = `
    ${referrerName} invites you to join DentiPal!

    Hi ${friendEmail}!

    ${referrerName} thinks you'd love DentiPal - the premier platform for dental professionals!

    ${personalMessage ? `Personal message from ${referrerName}: "${personalMessage}"` : ''}

    DentiPal connects dental professionals with amazing career opportunities. Whether you're looking for temporary shifts, consulting projects, or permanent positions, we've got you covered!

    Why Join DentiPal?
    💼 Access to exclusive job opportunities
    ⚡ Fast and easy application process  
    💰 Competitive compensation
    🤝 Direct connection with dental clinics
    📱 User-friendly mobile platform
    🎯 Personalized job matching

    Join DentiPal Now: ${signupUrl}

    By joining through this referral, both you and ${referrerName} may be eligible for special bonuses!

    Questions? Contact us at support@dentipal.com

    Join thousands of dental professionals who trust DentiPal for their career growth!
    `;
    
    return { subject, htmlBody, textBody };
}

// --- Main Handler Function ---

export const handler = async (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): Promise<HandlerResponse> => {
    
    // Use the defined CORS headers
    const headers = CORS_HEADERS;

    try {
        // Handle CORS preflight request
        // FIX: Cast to any to handle method access safely for both V1 and V2 types
        const method = (event as any).requestContext?.http?.method || (event as any).httpMethod;
        
        if (method === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ message: "CORS preflight successful" })
            };
        }

        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        const referralData: ReferralPayload = JSON.parse(event.body || "{}"); // Handle empty body safely

        // 2. Input Validation
        if (!referralData.friendEmail) {
            return {
                statusCode: 400,
                headers: headers, 
                body: JSON.stringify({ error: "Required field: friendEmail" })
            };
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(referralData.friendEmail)) {
            return {
                statusCode: 400,
                headers: headers, 
                body: JSON.stringify({ error: "Invalid email format" })
            };
        }

        const friendEmail: string = referralData.friendEmail.toLowerCase();

        // 3. Get Referrer's Profile
        const referrerProfileResult = await dynamodb.send(new GetItemCommand({
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } }
        }));
        
        const referrerProfile: ProfileItem | undefined = referrerProfileResult.Item as ProfileItem | undefined;

        if (!referrerProfile) {
            return {
                statusCode: 404,
                headers: headers, 
                body: JSON.stringify({ error: "Professional profile not found." })
            };
        }

        const referrerName: string = referrerProfile.full_name?.S || 'Your DentiPal friend';
        
        // 4. Create Referral Record in DynamoDB
        const referralId: string = uuidv4();
        const timestamp: string = new Date().toISOString();
        
        await dynamodb.send(new PutItemCommand({
            TableName: REFERRALS_TABLE,
            Item: {
                referralId: { S: referralId },
                referrerUserSub: { S: userSub },
                referrerName: { S: referrerName },
                friendEmail: { S: friendEmail },
                status: { S: 'sent' },
                sentAt: { S: timestamp },
                updatedAt: { S: timestamp }
            }
        }));

        // 5. Send Referral Email via SES
        const emailTemplate: EmailTemplate = createReferralEmail(
            referrerName, 
            friendEmail, 
            referralData.personalMessage, 
            userSub
        );
        
        const emailCommandInput: SendEmailCommandInput = {
            Source: 'jelladivya369@gmail.com', // Ensure this is a verified SES email address
            Destination: { ToAddresses: [friendEmail] },
            Message: {
                Subject: { Data: emailTemplate.subject, Charset: 'UTF-8' },
                Body: {
                    Html: { Data: emailTemplate.htmlBody, Charset: 'UTF-8' },
                    Text: { Data: emailTemplate.textBody, Charset: 'UTF-8' }
                }
            }
        };

        await ses.send(new SendEmailCommand(emailCommandInput));

        // 6. Success Response
        return {
            statusCode: 200,
            headers: headers, 
            body: JSON.stringify({
                message: "Referral invitation sent successfully",
                referralId,
                friendEmail,
                sentAt: timestamp,
                status: "sent",
                nextSteps: "Your friend will receive an email invitation to join DentiPal."
            })
        };
    } catch (error: any) {
        console.error("Error sending referral invite:", error);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        const errorMessage: string = (error as Error).message;
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // Use constants for error response headers
            body: JSON.stringify({ error: errorMessage })
        };
    }
};