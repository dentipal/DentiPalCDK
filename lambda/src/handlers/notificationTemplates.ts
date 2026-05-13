const APP_URL = process.env.APP_URL || "https://dentipal.com";

export interface ShiftContext {
    professionalName?: string;
    clinicName?: string;
    role?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    rate?: number | string;
    jobType?: string;
    actualHoursWorked?: number | string;
}

export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}

interface LayoutInput {
    eyebrow?: string;
    headline: string;
    intro: string;
    detailRows: Array<[string, string]>;
    footerNote?: string;
    cta: { label: string; url: string };
    secondaryCta?: { label: string; url: string };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
    }[c] as string));
}

function detailLines(ctx: ShiftContext): Array<[string, string]> {
    const rows: Array<[string, string]> = [];
    if (ctx.role) rows.push(["Role", ctx.role]);
    if (ctx.clinicName) rows.push(["Clinic", ctx.clinicName]);
    if (ctx.date) rows.push(["Date", ctx.date]);
    if (ctx.startTime && ctx.endTime) rows.push(["Time", `${ctx.startTime} – ${ctx.endTime}`]);
    else if (ctx.startTime) rows.push(["Time", ctx.startTime]);
    if (ctx.location) rows.push(["Location", ctx.location]);
    if (ctx.rate) rows.push(["Rate", `$${ctx.rate}/hr`]);
    return rows;
}

function layout(input: LayoutInput): { html: string; text: string } {
    const fontStack = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

    const detailHtml = input.detailRows.map(([k, v], idx) => {
        const isLast = idx === input.detailRows.length - 1;
        const border = isLast ? "" : "border-bottom:1px solid #e8e8ed;";
        return `<tr>
            <td style="padding:14px 0;color:#6e6e73;font-size:14px;font-weight:400;letter-spacing:-0.01em;${border}">${escapeHtml(k)}</td>
            <td style="padding:14px 0;color:#1d1d1f;font-size:14px;font-weight:500;letter-spacing:-0.01em;text-align:right;${border}">${escapeHtml(v)}</td>
        </tr>`;
    }).join("");

    const detailText = input.detailRows.map(([k, v]) => `${k}: ${v}`).join("\n");

    const eyebrowHtml = input.eyebrow
        ? `<p style="margin:0 0 10px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(input.eyebrow)}</p>`
        : "";

    const detailCardHtml = input.detailRows.length > 0
        ? `<table cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;margin:0 0 28px;">
            <tr><td style="padding:6px 22px;">
              <table width="100%" cellpadding="0" cellspacing="0">${detailHtml}</table>
            </td></tr>
          </table>`
        : "";

    const secondaryCtaHtml = input.secondaryCta
        ? `<p style="margin:14px 0 0;text-align:center;">
            <a href="${input.secondaryCta.url}" style="color:#1d1d1f;font-size:14px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;border-bottom:1px solid rgba(0,0,0,0.2);padding-bottom:2px;">${escapeHtml(input.secondaryCta.label)}</a>
          </p>`
        : "";

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>${escapeHtml(input.headline)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:${fontStack};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(input.intro)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
    <tr><td align="center" style="padding:48px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <tr><td style="padding:0 8px 18px;text-align:center;">
          <span style="display:inline-block;font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.02em;">DentiPal</span>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 40px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:44px 40px 32px;">
              ${eyebrowHtml}
              <h1 style="margin:0 0 14px;color:#1d1d1f;font-size:28px;font-weight:700;letter-spacing:-0.025em;line-height:1.15;">${escapeHtml(input.headline)}</h1>
              <p style="margin:0 0 28px;color:#424245;font-size:16px;line-height:1.5;letter-spacing:-0.01em;">${escapeHtml(input.intro)}</p>

              ${detailCardHtml}

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td align="center">
                  <a href="${input.cta.url}" style="display:inline-block;background:#1d1d1f;color:#ffffff;padding:14px 32px;border-radius:980px;font-size:15px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;line-height:1;">${escapeHtml(input.cta.label)}</a>
                </td></tr>
              </table>
              ${secondaryCtaHtml}

              ${input.footerNote ? `<div style="margin:32px 0 0;padding:18px 20px;background:rgba(245,245,247,0.7);border:1px solid rgba(0,0,0,0.04);border-radius:14px;">
                <p style="margin:0;color:#6e6e73;font-size:13px;line-height:1.55;letter-spacing:-0.005em;">${escapeHtml(input.footerNote)}</p>
              </div>` : ""}
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px;text-align:center;">
          <p style="margin:0 0 10px;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            You're receiving this because notifications are enabled on your DentiPal account.
          </p>
          <p style="margin:0;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            <a href="${APP_URL}/professional/profile" style="color:#1d1d1f;text-decoration:none;font-weight:500;">Manage preferences</a>
            &nbsp;·&nbsp;
            <a href="${APP_URL}" style="color:#1d1d1f;text-decoration:none;font-weight:500;">Open DentiPal</a>
          </p>
          <p style="margin:18px 0 0;color:#a1a1a6;font-size:11px;letter-spacing:0.01em;">&copy; ${new Date().getFullYear()} DentiPal</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
        "DentiPal",
        "",
        ...(input.eyebrow ? [input.eyebrow.toUpperCase(), ""] : []),
        input.headline,
        "",
        input.intro,
        ...(input.detailRows.length > 0 ? ["", detailText] : []),
        "",
        `${input.cta.label}: ${input.cta.url}`,
        ...(input.secondaryCta ? [`${input.secondaryCta.label}: ${input.secondaryCta.url}`] : []),
        ...(input.footerNote ? ["", input.footerNote] : []),
        "",
        "—",
        `Manage preferences: ${APP_URL}/professional/profile`,
    ].filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");

    return { html, text };
}

function greeting(name?: string): string {
    return name ? `Hello ${name},` : "Hello,";
}

export function shiftScheduled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift confirmed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} we are pleased to confirm that your application has been accepted. Your shift details are listed below for your reference.`;
    const { html, text } = layout({
        eyebrow: "Shift confirmed",
        headline: "Your shift has been confirmed",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift details", url: `${APP_URL}/professional/scheduled-shifts` },
        secondaryCta: { label: "Add this shift to your calendar", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Please plan to arrive a few minutes ahead of your scheduled start time. Should anything change on your end, kindly notify the clinic at the earliest opportunity.",
    });
    return { subject, html, text };
}

export function applicationRejected(ctx: ShiftContext): RenderedEmail {
    const subject = `Application status update${ctx.role ? ` — ${ctx.role}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} thank you for submitting your application. After careful consideration, the clinic has chosen to proceed with another candidate for this position. This decision often reflects scheduling fit and specific requirements rather than the quality of your profile.`;
    const { html, text } = layout({
        eyebrow: "Application update",
        headline: "Application status update",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Browse available shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "Maintaining a complete profile with current certifications and availability significantly improves your visibility to clinics on the platform.",
    });
    return { subject, html, text };
}

export function inviteSent(ctx: ShiftContext): RenderedEmail {
    const subject = `Invitation to apply${ctx.role ? ` — ${ctx.role}` : ""}${ctx.clinicName ? ` at ${ctx.clinicName}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} ${ctx.clinicName || "a clinic"} has identified you as a strong match for an upcoming shift and has extended a direct invitation to apply.`;
    const { html, text } = layout({
        eyebrow: "New invitation",
        headline: "You have received an invitation",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review invitation", url: `${APP_URL}/professional/invites` },
        footerNote: "Invitations are time-sensitive. We recommend responding at your earliest convenience to secure this opportunity.",
    });
    return { subject, html, text };
}

export function shiftCancelled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift cancelled${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} we regret to inform you that the clinic has cancelled this scheduled shift. No further action is required on your part, and your availability has been restored for this time.`;
    const { html, text } = layout({
        eyebrow: "Shift cancelled",
        headline: "Your shift has been cancelled",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Browse available shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "We understand cancellations can be disruptive. Should you experience repeated cancellations from the same clinic, please contact DentiPal support so we can review the situation.",
    });
    return { subject, html, text };
}

export function shiftEdited(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift details updated${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has updated the details of your scheduled shift. Please review the revised information below carefully prior to your shift.`;
    const { html, text } = layout({
        eyebrow: "Shift updated",
        headline: "Your shift details have been updated",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View updated shift", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "If the revised time or location is no longer suitable, please cancel the shift and notify the clinic at the earliest opportunity.",
    });
    return { subject, html, text };
}

export function shiftReminderH24(ctx: ShiftContext): RenderedEmail {
    const subject = `Reminder: shift tomorrow${ctx.startTime ? ` at ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} this is a courtesy reminder that you are scheduled for a shift in approximately 24 hours. The full details are provided below for your reference.`;
    const { html, text } = layout({
        eyebrow: "24-hour reminder",
        headline: "Your shift is scheduled for tomorrow",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift details", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Please plan your travel, prepare your uniform, and confirm any specific requirements with the clinic in advance.",
    });
    return { subject, html, text };
}

export function shiftReminderH1(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift starting soon${ctx.startTime ? ` at ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} your shift is scheduled to begin in approximately one hour. We recommend departing now to ensure you arrive a few minutes early.`;
    const { html, text } = layout({
        eyebrow: "Starting in 1 hour",
        headline: "Your shift begins shortly",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift details", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Should you anticipate any delay, please notify the clinic immediately so they can make appropriate arrangements.",
    });
    return { subject, html, text };
}

export function shiftCompleted(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift completed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has confirmed the successful completion of your shift. Thank you for your contribution — your shift record has been updated accordingly.`;
    const detailRows = detailLines(ctx);
    if (ctx.actualHoursWorked !== undefined && ctx.actualHoursWorked !== null && ctx.actualHoursWorked !== "") {
        detailRows.push(["Hours worked", `${ctx.actualHoursWorked}h`]);
    }
    const { html, text } = layout({
        eyebrow: "Shift completed",
        headline: "Your shift has been completed",
        intro,
        detailRows,
        cta: { label: "View completed shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "Payment is processed by the clinic in accordance with their standard pay cycle. Should you have any concerns regarding payment, please contact DentiPal support for assistance.",
    });
    return { subject, html, text };
}

export function applicationReceived(ctx: ShiftContext): RenderedEmail {
    const who = ctx.professionalName?.trim() || "A professional";
    const subject = `New application received${ctx.role ? ` — ${ctx.role}` : ""}`;
    const intro = `${who} has submitted an application for your ${ctx.role ? `${ctx.role} ` : ""}shift. Please review their profile and respond from the Action Needed view to keep the candidate engaged.`;
    const { html, text } = layout({
        eyebrow: "New application",
        headline: "A new application has been received",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review candidate", url: `${APP_URL}/dashboard?view=actionNeeded` },
        footerNote: "Qualified professionals often accept other opportunities within hours. Prompt responses significantly improve your hiring success rate.",
    });
    return { subject, html, text };
}

export function shiftNoShow(ctx: ShiftContext): RenderedEmail {
    const subject = `No-show reported${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has reported that you did not attend this scheduled shift. The DentiPal administration team has been notified and will review the report.`;
    const { html, text } = layout({
        eyebrow: "Attendance report",
        headline: "Shift reported as a no-show",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Contact support", url: `${APP_URL}/professional/dashboard` },
        footerNote: "If you believe this report has been recorded in error — for example, you attended but were not formally signed in — please contact DentiPal support promptly with any supporting information.",
    });
    return { subject, html, text };
}

export function renderTemplate(eventType: string, ctx: ShiftContext): RenderedEmail | null {
    switch (eventType) {
        case "shift-scheduled": return shiftScheduled(ctx);
        case "application-rejected": return applicationRejected(ctx);
        case "invite-sent": return inviteSent(ctx);
        case "application-received": return applicationReceived(ctx);
        case "shift-cancelled": return shiftCancelled(ctx);
        case "shift-modified": return shiftEdited(ctx);
        case "shift-reminder-h24": return shiftReminderH24(ctx);
        case "shift-reminder-h1": return shiftReminderH1(ctx);
        case "shift-completed": return shiftCompleted(ctx);
        case "shift-no-show": return shiftNoShow(ctx);
        default: return null;
    }
}
