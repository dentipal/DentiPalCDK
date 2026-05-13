import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    QueryCommand,
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
import { corsHeaders } from "./corsHeaders";
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
    // ProfessionalProfiles stores names split: first_name + last_name. The
    // legacy `full_name` field is checked as a fallback in case older rows
    // still use it.
    first_name?: AttributeValue;
    last_name?: AttributeValue;
    full_name?: AttributeValue;
    // Stored on the profile row for some users — used as a fallback Reply-To
    // address when the Cognito access token doesn't carry an `email` claim.
    email?: AttributeValue;
    contact_email?: AttributeValue;
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
const SES_REGION: string = process.env.SES_REGION || process.env.REGION!;
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
const REFERRALS_TABLE: string = process.env.REFERRALS_TABLE!;
// Frontend base URL the referee clicks through to. Wired in the CDK stack
// (DentiPal-Backend-Monolith) as APP_URL. Local fallback exists so handler
// tests / sam-local don't crash, but production must set it.
const APP_URL: string = process.env.APP_URL || "http://localhost:5173";
// Verified SES "From" identity. Wired in the CDK stack as SES_FROM.
const SES_FROM: string = process.env.SES_FROM || "no-reply@dentipal.com";
// GSI on the Referrals table — partition key `referrerUserSub`. Used to scan
// a referrer's existing invites cheaply (vs. table-wide Scan).
const REFERRER_INDEX = "ReferrerIndex";

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);
const ses = new SESClient({ region: SES_REGION } as SESClientConfig);

// Get CORS Origin from environment variable or default to localhost


// --- Email Template Function ---

/**
 * Creates the HTML and text bodies for the referral email.
 */
function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c] as string));
}

function createReferralEmail(
    referrerName: string,
    friendEmail: string,
    personalMessage: string | undefined,
    referrerUserSub: string
): EmailTemplate {
    const subject = `${referrerName} invited you to DentiPal`;
    const signupUrl = `${APP_URL.replace(/\/$/, "")}/professional-signup?ref=${encodeURIComponent(referrerUserSub)}`;
    const safeReferrer = escapeHtml(referrerName);
    const safeFriend = escapeHtml(friendEmail);
    const safeMessage = personalMessage ? escapeHtml(personalMessage) : "";
    const fontStack = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const year = new Date().getFullYear();

    const benefits: Array<[string, string]> = [
        ["Exclusive opportunities", "Receive priority access to shifts posted by clinics in your area."],
        ["Streamlined applications", "Submit applications through a single profile, eliminating repetitive paperwork."],
        ["Transparent compensation", "Review the hourly rate and full shift details before submitting an application."],
        ["Direct communication", "Engage directly with hiring clinics without intermediaries."],
    ];

    const benefitsHtml = benefits.map(([title, body], idx) => {
        const isLast = idx === benefits.length - 1;
        const border = isLast ? "" : "border-bottom:1px solid #e8e8ed;";
        return `<tr><td style="padding:18px 0;${border}">
            <p style="margin:0 0 4px;color:#1d1d1f;font-size:15px;font-weight:600;letter-spacing:-0.01em;">${escapeHtml(title)}</p>
            <p style="margin:0;color:#6e6e73;font-size:14px;line-height:1.5;letter-spacing:-0.005em;">${escapeHtml(body)}</p>
          </td></tr>`;
    }).join("");

    const personalMessageHtml = safeMessage ? `
        <div style="margin:0 0 28px;padding:22px 24px;background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;">
          <p style="margin:0 0 8px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">A message from ${safeReferrer}</p>
          <p style="margin:0;color:#1d1d1f;font-size:15px;line-height:1.55;letter-spacing:-0.01em;font-style:italic;">&ldquo;${safeMessage}&rdquo;</p>
        </div>` : "";

    const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>${safeReferrer} invited you to DentiPal</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:${fontStack};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safeReferrer} thinks you'd be a great fit for DentiPal — the platform that connects dental professionals with clinics directly.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
    <tr><td align="center" style="padding:48px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <tr><td style="padding:0 8px 18px;text-align:center;">
          <span style="display:inline-block;font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.02em;">DentiPal</span>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 40px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:44px 40px 32px;">

              <p style="margin:0 0 10px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Personal invitation</p>
              <h1 style="margin:0 0 14px;color:#1d1d1f;font-size:28px;font-weight:700;letter-spacing:-0.025em;line-height:1.15;">${safeReferrer} has invited you to DentiPal</h1>
              <p style="margin:0 0 28px;color:#424245;font-size:16px;line-height:1.55;letter-spacing:-0.01em;">
                Hello, ${safeReferrer} has invited you to join DentiPal — the platform dental professionals use to find shifts at trusted clinics. This invitation has been sent to <strong style="color:#1d1d1f;font-weight:600;">${safeFriend}</strong>.
              </p>

              ${personalMessageHtml}

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px;">
                <tr><td align="center">
                  <a href="${signupUrl}" style="display:inline-block;background:#1d1d1f;color:#ffffff;padding:14px 32px;border-radius:980px;font-size:15px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;line-height:1;">Accept invitation</a>
                </td></tr>
                <tr><td align="center" style="padding-top:14px;">
                  <p style="margin:0;color:#86868b;font-size:13px;letter-spacing:-0.005em;">Free to join · Registration takes approximately two minutes</p>
                </td></tr>
              </table>

              <p style="margin:0 0 12px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Why join DentiPal</p>
              <table cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;margin:0 0 28px;">
                <tr><td style="padding:6px 22px;">
                  <table width="100%" cellpadding="0" cellspacing="0">${benefitsHtml}</table>
                </td></tr>
              </table>

              <div style="margin:0 0 0;padding:18px 20px;background:rgba(245,245,247,0.7);border:1px solid rgba(0,0,0,0.04);border-radius:14px;">
                <p style="margin:0;color:#6e6e73;font-size:13px;line-height:1.55;letter-spacing:-0.005em;">
                  Registering through this link will record ${safeReferrer} as your referrer. Both parties may become eligible for referral rewards upon the completion of your first shift.
                </p>
              </div>

            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px;text-align:center;">
          <p style="margin:0;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            This invitation was sent to ${safeFriend}. If you were not expecting it, you may disregard this message.
          </p>
          <p style="margin:18px 0 0;color:#a1a1a6;font-size:11px;letter-spacing:0.01em;">&copy; ${year} DentiPal</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const textBody = [
        "DentiPal",
        "",
        `${referrerName} has invited you to DentiPal`,
        "",
        `Hello, ${referrerName} has invited you to join DentiPal — the platform dental professionals use to find shifts at trusted clinics. This invitation has been sent to ${friendEmail}.`,
        ...(personalMessage ? ["", `A message from ${referrerName}:`, `"${personalMessage}"`] : []),
        "",
        "Why join DentiPal:",
        ...benefits.map(([t, b]) => `  • ${t} — ${b}`),
        "",
        `Accept invitation: ${signupUrl}`,
        "Free to join · Registration takes approximately two minutes",
        "",
        `Registering through this link will record ${referrerName} as your referrer. Both parties may become eligible for referral rewards upon the completion of your first shift.`,
        "",
        `This invitation was sent to ${friendEmail}. If you were not expecting it, you may disregard this message.`,
    ].join("\n");

    return { subject, htmlBody, textBody };
}

// --- Main Handler Function ---

export const handler = async (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): Promise<HandlerResponse> => {
    
    // Use the defined CORS headers
    const headers = corsHeaders(event);

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
        const referrerEmail: string | undefined = userInfo.email?.toLowerCase();

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

        // 2b. Self-referral guard — block users from inviting themselves.
        // Falls open if the token didn't carry an email claim (access tokens
        // sometimes don't); the canonical check is the duplicate-invite guard
        // below, which still catches a self-invite on the second attempt.
        if (referrerEmail && referrerEmail === friendEmail) {
            return {
                statusCode: 400,
                headers: headers,
                body: JSON.stringify({ error: "You can't refer your own email address." })
            };
        }

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

        // Resolve referrer's display name: prefer `first_name + last_name`
        // (the canonical fields on ProfessionalProfiles), fall back to the
        // legacy `full_name`, finally to a generic label so the email still
        // sends if the profile is incomplete.
        const firstName = referrerProfile.first_name?.S?.trim() || "";
        const lastName = referrerProfile.last_name?.S?.trim() || "";
        const joinedName = [firstName, lastName].filter(Boolean).join(" ");
        const referrerName: string =
            joinedName
            || referrerProfile.full_name?.S?.trim()
            || 'Your DentiPal friend';

        // Reply-To resolution order:
        //   1. email claim on the access token (set by Cognito when the app
        //      client requests the `email` scope)
        //   2. `email` or `contact_email` stored on the professional profile row
        // If neither is available we simply omit Reply-To and replies bounce
        // back to a no-reply mailbox — acceptable, not ideal.
        const replyToEmail: string | undefined =
            referrerEmail
            || referrerProfile.email?.S?.toLowerCase()
            || referrerProfile.contact_email?.S?.toLowerCase()
            || undefined;

        // 3b. Duplicate-invite guard — Query the ReferrerIndex GSI for any
        // existing referral the same referrer has already sent to this email.
        // Status `sent` means an invite is in flight; `signed_up` and
        // `bonus_due` mean the friend already converted. In all three cases
        // we refuse to write a second row (which would create double-credit
        // risk and email spam).
        const existing = await dynamodb.send(new QueryCommand({
            TableName: REFERRALS_TABLE,
            IndexName: REFERRER_INDEX,
            KeyConditionExpression: "referrerUserSub = :sub",
            FilterExpression:
                "friendEmail = :email AND #status IN (:sent, :signedUp, :bonusDue)",
            ExpressionAttributeNames: { "#status": "status" },
            ExpressionAttributeValues: {
                ":sub": { S: userSub },
                ":email": { S: friendEmail },
                ":sent": { S: "sent" },
                ":signedUp": { S: "signed_up" },
                ":bonusDue": { S: "bonus_due" },
            },
            Limit: 1,
        }));

        if (existing.Items && existing.Items.length > 0) {
            const prior = existing.Items[0];
            const priorStatus = prior.status?.S || "sent";
            const msg = priorStatus === "sent"
                ? "You've already invited this email. Wait for them to sign up before re-sending."
                : "This person has already joined DentiPal through your referral.";
            return {
                statusCode: 409,
                headers: headers,
                body: JSON.stringify({ error: msg, status: priorStatus })
            };
        }

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
            Source: SES_FROM,
            Destination: { ToAddresses: [friendEmail] },
            // From: DentiPal's verified domain (passes SPF/DKIM/DMARC).
            // Reply-To: the referring professional, so the friend hitting
            // "Reply" reaches a human and not the no-reply mailbox.
            ...(replyToEmail ? { ReplyToAddresses: [replyToEmail] } : {}),
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
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        const errorMessage: string = (error as Error).message;
        
        return {
            statusCode: 500,
            headers: corsHeaders(event), // Use constants for error response headers
            body: JSON.stringify({ error: errorMessage })
        };
    }
};