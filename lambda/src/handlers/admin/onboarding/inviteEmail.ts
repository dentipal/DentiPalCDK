// Branded onboarding-invite email used by the admin onboarding lambdas.
//
// Why this exists: Cognito's default AdminCreateUser email is a plain-text
// "Your username is X and temporary password is Y" with no sender identity,
// no DentiPal branding, and no indication of *what kind* of account the
// recipient just received. This module generates the temp password ourselves
// (so Cognito accepts it via TemporaryPassword + MessageAction: SUPPRESS) and
// sends a custom HTML email through the existing SES utility.
//
// Used by:
//   - onboardProfessional.ts
//   - onboardClinic.ts
// Not used by:
//   - addClinicForOwner.ts (the owner already has a password from initial
//     onboarding; no new invite needed)

import { randomBytes } from "crypto";
import { sendNotificationEmail } from "../../sendNotificationEmail";

const LOWER = "abcdefghijkmnopqrstuvwxyz";   // no 'l' to avoid 1/l confusion
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";    // no 'I', 'O' for the same reason
const DIGITS = "23456789";                    // no '0' or '1'
const SYMBOLS = "!@#$%&*?_-";                 // safe-to-quote subset

const pickFrom = (pool: string, n: number): string[] => {
    const bytes = randomBytes(n);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(pool[bytes[i] % pool.length]);
    return out;
};

const shuffle = <T,>(arr: T[]): T[] => {
    const bytes = randomBytes(arr.length);
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = bytes[i] % (i + 1);
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
};

/**
 * Generate a 14-character password that satisfies the project's Cognito
 * password policy (min 8 chars, digits + lowercase + uppercase + symbols).
 * Cryptographically random via Node's `crypto.randomBytes`.
 */
export const generateTempPassword = (): string => {
    const chars = [
        ...pickFrom(LOWER, 4),
        ...pickFrom(UPPER, 4),
        ...pickFrom(DIGITS, 3),
        ...pickFrom(SYMBOLS, 3),
    ];
    return shuffle(chars).join("");
};

interface BaseTemplateInput {
    firstName?: string;
    email: string;
    tempPassword: string;
    loginUrl: string;
}

interface ProfessionalTemplateInput extends BaseTemplateInput {
    roleDisplayName: string; // e.g. "Dentist", "Dental Hygienist"
}

const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]!));

// Shared HTML shell — keeps the inline styles consistent across user types.
const htmlShell = (opts: {
    headline: string;
    leadParagraph: string;
    extraBeforeCreds?: string;
    email: string;
    tempPassword: string;
    loginUrl: string;
    loginLabel: string;
    nextStepsBullets: string[];
}): string => {
    const bulletsHtml = opts.nextStepsBullets
        .map((b) => `<li style="margin: 6px 0; color: #424245; line-height: 1.5;">${b}</li>`)
        .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(opts.headline)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f5f5f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1d1d1f;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f5f5f7; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; background: #ffffff; border-radius: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
          <tr>
            <td style="padding: 28px 32px 8px;">
              <div style="font-size: 14px; font-weight: 600; letter-spacing: -0.01em; color: #6e6e73;">DentiPal</div>
            </td>
          </tr>
          <tr>
            <td style="padding: 0 32px 8px;">
              <h1 style="margin: 0 0 8px; font-size: 22px; line-height: 1.25; font-weight: 600; color: #1d1d1f; letter-spacing: -0.02em;">
                ${escapeHtml(opts.headline)}
              </h1>
              <p style="margin: 0 0 16px; color: #424245; line-height: 1.55; font-size: 15px;">
                ${opts.leadParagraph}
              </p>
              ${opts.extraBeforeCreds || ""}
            </td>
          </tr>
          <tr>
            <td style="padding: 8px 32px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background: #f5f5f7; border-radius: 12px;">
                <tr>
                  <td style="padding: 16px 18px;">
                    <div style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6e6e73;">Email</div>
                    <div style="font-size: 15px; color: #1d1d1f; margin-top: 2px; word-break: break-all;">${escapeHtml(opts.email)}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 0 18px 16px;">
                    <div style="font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #6e6e73;">Temporary password</div>
                    <div style="font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 17px; color: #1d1d1f; margin-top: 2px; background: #ffffff; border: 1px solid rgba(0,0,0,0.08); border-radius: 8px; padding: 10px 12px; display: inline-block; letter-spacing: 0.02em;">${escapeHtml(opts.tempPassword)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px 32px 12px;">
              <a href="${escapeHtml(opts.loginUrl)}" style="display: inline-block; background: #1d1d1f; color: #ffffff; text-decoration: none; font-size: 15px; font-weight: 500; padding: 12px 26px; border-radius: 999px; letter-spacing: -0.01em;">
                ${escapeHtml(opts.loginLabel)}
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 8px;">
              <div style="font-size: 13px; font-weight: 600; color: #1d1d1f; margin-bottom: 6px;">What happens next</div>
              <ul style="margin: 0; padding-left: 18px; font-size: 14px;">
                ${bulletsHtml}
              </ul>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 32px 28px;">
              <p style="margin: 0; font-size: 12px; color: #86868b; line-height: 1.55;">
                This invite was sent by the <strong style="color: #6e6e73; font-weight: 600;">DentiPal Team</strong>. The temporary password above expires in 7 days. If you weren't expecting this email, you can safely ignore it &mdash; no account will be activated until you sign in.
              </p>
            </td>
          </tr>
        </table>
        <div style="margin-top: 16px; font-size: 11px; color: #86868b;">
          DentiPal &middot; <a href="https://dentipal.com" style="color: #86868b; text-decoration: none;">dentipal.com</a>
        </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const textShell = (opts: {
    headline: string;
    lead: string;
    email: string;
    tempPassword: string;
    loginUrl: string;
    nextSteps: string[];
}): string => {
    const stepsText = opts.nextSteps.map((s, i) => `${i + 1}. ${s}`).join("\n");
    return [
        opts.headline,
        "",
        opts.lead,
        "",
        `Email: ${opts.email}`,
        `Temporary password: ${opts.tempPassword}`,
        "",
        `Sign in: ${opts.loginUrl}`,
        "",
        "What happens next:",
        stepsText,
        "",
        "This invite was sent by the DentiPal Team. The temporary password expires in 7 days.",
        "If you weren't expecting this email, you can safely ignore it.",
        "",
        "— DentiPal",
        "https://dentipal.com",
    ].join("\n");
};

const buildProfessionalEmail = (input: ProfessionalTemplateInput) => {
    const greeting = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi there,";
    const role = escapeHtml(input.roleDisplayName);

    return {
        subject: `Welcome to DentiPal — your ${input.roleDisplayName} account is ready`,
        html: htmlShell({
            headline: `Welcome to DentiPal, ${input.firstName ? escapeHtml(input.firstName) : "there"}`,
            leadParagraph: `${greeting} the DentiPal team has created a <strong>Professional</strong> account for you with the role <strong>${role}</strong>. Use the temporary password below to sign in for the first time.`,
            email: input.email,
            tempPassword: input.tempPassword,
            loginUrl: input.loginUrl,
            loginLabel: "Sign in to DentiPal",
            nextStepsBullets: [
                "Sign in with the email and temporary password above.",
                "You'll be prompted to set a <strong>permanent password</strong> on first sign-in.",
                "Complete your professional profile (skills, qualifications, address) so clinics can find you.",
                "Start browsing shifts and apply to jobs that match your role.",
            ],
        }),
        text: textShell({
            headline: `Welcome to DentiPal, ${input.firstName || "there"}`,
            lead: `The DentiPal team has created a Professional account for you with the role "${input.roleDisplayName}". Use the temporary password below to sign in for the first time.`,
            email: input.email,
            tempPassword: input.tempPassword,
            loginUrl: input.loginUrl,
            nextSteps: [
                "Sign in with the email and temporary password above.",
                "You'll be prompted to set a permanent password on first sign-in.",
                "Complete your professional profile so clinics can find you.",
                "Start browsing and applying to shifts that match your role.",
            ],
        }),
    };
};

const buildClinicEmail = (input: BaseTemplateInput) => {
    const greeting = input.firstName ? `Hi ${escapeHtml(input.firstName)},` : "Hi there,";

    return {
        subject: "Welcome to DentiPal — your Clinic account is ready",
        html: htmlShell({
            headline: `Welcome to DentiPal, ${input.firstName ? escapeHtml(input.firstName) : "there"}`,
            leadParagraph: `${greeting} the DentiPal team has created a <strong>Clinic</strong> account for you as the primary owner. Use the temporary password below to sign in for the first time.`,
            email: input.email,
            tempPassword: input.tempPassword,
            loginUrl: input.loginUrl,
            loginLabel: "Sign in to DentiPal",
            nextStepsBullets: [
                "Sign in with the email and temporary password above.",
                "You'll be prompted to set a <strong>permanent password</strong> on first sign-in.",
                "If your clinic details aren't already filled in, you'll be guided to complete your clinic profile.",
                "Once set up, post shifts and find qualified dental professionals.",
            ],
        }),
        text: textShell({
            headline: `Welcome to DentiPal, ${input.firstName || "there"}`,
            lead: "The DentiPal team has created a Clinic account for you as the primary owner. Use the temporary password below to sign in for the first time.",
            email: input.email,
            tempPassword: input.tempPassword,
            loginUrl: input.loginUrl,
            nextSteps: [
                "Sign in with the email and temporary password above.",
                "You'll be prompted to set a permanent password on first sign-in.",
                "If your clinic details aren't already filled in, you'll be guided to complete your clinic profile.",
                "Post shifts and find qualified dental professionals.",
            ],
        }),
    };
};

const appBaseUrl = (): string =>
    (process.env.APP_URL || process.env.FRONTEND_ORIGIN || "https://dentipal.com").replace(/\/+$/, "");

/**
 * Send a branded invite email to a newly-onboarded professional. Logs and
 * swallows SES failures — the admin can resend by triggering AdminResetUserPassword
 * if delivery fails.
 */
export async function sendProfessionalInviteEmail(input: {
    firstName?: string;
    email: string;
    tempPassword: string;
    roleDisplayName: string;
}): Promise<void> {
    const loginUrl = `${appBaseUrl()}/professional-login`;
    const { subject, html, text } = buildProfessionalEmail({ ...input, loginUrl });
    await sendNotificationEmail({ to: input.email, subject, html, text });
}

/**
 * Send a branded invite email to a newly-onboarded clinic owner.
 */
export async function sendClinicInviteEmail(input: {
    firstName?: string;
    email: string;
    tempPassword: string;
}): Promise<void> {
    const loginUrl = `${appBaseUrl()}/clinic-login`;
    const { subject, html, text } = buildClinicEmail({ ...input, loginUrl });
    await sendNotificationEmail({ to: input.email, subject, html, text });
}
