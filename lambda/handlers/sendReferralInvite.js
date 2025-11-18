"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SendEmailCommand, SESClient } = require("@aws-sdk/client-ses");
const { v4: uuidv4 } = require("uuid");
const utils_1 = require('./utils'); // Ensure this path is correct based on your file structure

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const ses = new SESClient({ region: process.env.SES_REGION });

// Function to create the referral email template (unchanged, keeping for context)
function createReferralEmail(referrerName, friendEmail, personalMessage, referrerUserSub) {
  const subject = `${referrerName} invites you to join DentiPal! 🦷`;
  const signupUrl = `http://localhost:5173/professional-signup?ref=${referrerUserSub}`;
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
      .cta-button { display: inline-block; background-color: #f8f8f8; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; margin: 20px 0; }
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

const handler = async (event) => {
    // Define CORS headers here to be included in all responses
    const headers = {
        'Content-Type': 'application/json',
        // IMPORTANT: For local development, use 'http://localhost:5173'.
        // For production, this should be your actual frontend domain, e.g., 'https://your-frontend-domain.com'
        'Access-Control-Allow-Origin': 'http://localhost:5173', // Or '*' for development (less secure)
        'Access-Control-Allow-Methods': 'POST,OPTIONS', // Include OPTIONS for preflight requests
        'Access-Control-Allow-Headers': 'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
        'Access-Control-Allow-Credentials': true, // If you ever use cookies/credentials
    };

    try {
        // Handle CORS preflight request
        if (event.httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: headers,
                body: JSON.stringify({ message: "CORS preflight successful" })
            };
        }

        const userSub = await utils_1.validateToken(event); // Ensure this function is correctly imported
        const referralData = JSON.parse(event.body);

        if (!referralData.friendEmail) {
            return {
                statusCode: 400,
                headers: headers, // Include headers in error response
                body: JSON.stringify({ error: "Required field: friendEmail" })
            };
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(referralData.friendEmail)) {
            return {
                statusCode: 400,
                headers: headers, // Include headers in error response
                body: JSON.stringify({ error: "Invalid email format" })
            };
        }

        const friendEmail = referralData.friendEmail.toLowerCase();

        // Get referrer's profile
        const referrerProfile = await dynamodb.send(new GetItemCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } }
        }));
        if (!referrerProfile.Item) {
            return {
                statusCode: 404,
                headers: headers, // Include headers in error response
                body: JSON.stringify({ error: "Professional profile not found." })
            };
        }

        const referrerName = referrerProfile.Item.full_name?.S || 'Your DentiPal friend';
        
        // Create a referral record
        const referralId = uuidv4();
        const timestamp = new Date().toISOString();
        
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.REFERRALS_TABLE,
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

        // Send referral email
        const emailTemplate = createReferralEmail(referrerName, friendEmail, referralData.personalMessage, userSub);
        const emailCommand = new SendEmailCommand({
            Source: 'jelladivya369@gmail.com', // Ensure this is a verified SES email
            Destination: { ToAddresses: [friendEmail] },
            Message: {
                Subject: { Data: emailTemplate.subject, Charset: 'UTF-8' },
                Body: {
                    Html: { Data: emailTemplate.htmlBody, Charset: 'UTF-8' },
                    Text: { Data: emailTemplate.textBody, Charset: 'UTF-8' }
                }
            }
        });

        await ses.send(emailCommand);

        return {
            statusCode: 200,
            headers: headers, // Include headers in success response
            body: JSON.stringify({
                message: "Referral invitation sent successfully",
                referralId,
                friendEmail,
                sentAt: timestamp,
                status: "sent",
                nextSteps: "Your friend will receive an email invitation to join DentiPal."
            })
        };
    } catch (error) {
        console.error("Error sending referral invite:", error);
        return {
            statusCode: 500,
            headers: headers, // Include headers in general error response
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.handler = handler;