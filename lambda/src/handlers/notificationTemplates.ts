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
    return name ? `Hi ${name},` : "Hi there,";
}

export function shiftScheduled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift confirmed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} good news — your application was accepted. Your shift is locked in and the details are below.`;
    const { html, text } = layout({
        eyebrow: "Shift confirmed",
        headline: "You're on the schedule",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift", url: `${APP_URL}/professional/scheduled-shifts` },
        secondaryCta: { label: "Add to calendar in DentiPal", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Please arrive a few minutes early. If anything changes, message the clinic directly through DentiPal chat.",
    });
    return { subject, html, text };
}

export function applicationRejected(ctx: ShiftContext): RenderedEmail {
    const subject = `Update on your application${ctx.role ? ` for ${ctx.role}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic chose another candidate for this role. It's not a reflection of your profile — fit and timing play a big part. New shifts go up every day.`;
    const { html, text } = layout({
        eyebrow: "Application update",
        headline: "Not selected this time",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Browse open shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "Tip: a complete profile with up-to-date certifications and availability gets noticed faster.",
    });
    return { subject, html, text };
}

export function inviteSent(ctx: ShiftContext): RenderedEmail {
    const subject = `${ctx.clinicName || "A clinic"} invited you to apply${ctx.role ? ` — ${ctx.role}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} ${ctx.clinicName || "a clinic"} thinks you'd be a great fit for an upcoming shift and sent you a direct invitation.`;
    const { html, text } = layout({
        eyebrow: "New invitation",
        headline: "You've been invited",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review invitation", url: `${APP_URL}/professional/invites` },
        footerNote: "Invitations are time-sensitive. Reviewing within a few hours gives you the best chance of securing the shift.",
    });
    return { subject, html, text };
}

export function shiftCancelled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift cancelled${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has cancelled this scheduled shift. No action is needed on your end — the time slot is free again.`;
    const { html, text } = layout({
        eyebrow: "Shift cancelled",
        headline: "Your shift has been cancelled",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Find another shift", url: `${APP_URL}/professional/dashboard` },
        footerNote: "We know cancellations are frustrating. Reach out to DentiPal support if this happens repeatedly with the same clinic.",
    });
    return { subject, html, text };
}

export function shiftEdited(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift details updated${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic updated the details of your scheduled shift. Please review the latest information below carefully.`;
    const { html, text } = layout({
        eyebrow: "Shift updated",
        headline: "Your shift details changed",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View updated shift", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "If the new time or location no longer works for you, please cancel and notify the clinic as soon as possible.",
    });
    return { subject, html, text };
}

export function shiftReminderH24(ctx: ShiftContext): RenderedEmail {
    const subject = `Reminder: shift tomorrow${ctx.startTime ? ` at ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} a quick heads-up — you're scheduled for a shift in about 24 hours. Here's everything you need to know.`;
    const { html, text } = layout({
        eyebrow: "24-hour reminder",
        headline: "Your shift is tomorrow",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift details", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Plan your travel, prep your uniform, and confirm any special requirements with the clinic through DentiPal chat.",
    });
    return { subject, html, text };
}

export function shiftReminderH1(ctx: ShiftContext): RenderedEmail {
    const subject = `Starting soon${ctx.startTime ? ` — ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} your shift starts in about an hour. Time to head out so you arrive a few minutes early.`;
    const { html, text } = layout({
        eyebrow: "Starting in 1 hour",
        headline: "Your shift starts soon",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Open DentiPal", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Running late? Message the clinic immediately through DentiPal chat — they appreciate the heads-up.",
    });
    return { subject, html, text };
}

export function shiftCompleted(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift completed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has marked your shift as complete. Thanks for the great work — your record has been updated.`;
    const detailRows = detailLines(ctx);
    if (ctx.actualHoursWorked !== undefined && ctx.actualHoursWorked !== null && ctx.actualHoursWorked !== "") {
        detailRows.push(["Hours worked", `${ctx.actualHoursWorked}h`]);
    }
    const { html, text } = layout({
        eyebrow: "Shift completed",
        headline: "Nice work today",
        intro,
        detailRows,
        cta: { label: "View completed shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "Payment is processed by the clinic on their normal pay cycle. If anything looks off, reach out to DentiPal support and we'll help sort it out.",
    });
    return { subject, html, text };
}

export function applicationReceived(ctx: ShiftContext): RenderedEmail {
    const who = ctx.professionalName?.trim() || "A professional";
    const subject = `New applicant${ctx.role ? ` for your ${ctx.role} shift` : ""}`;
    const intro = `${who} just applied to your shift${ctx.role ? ` for ${ctx.role}` : ""}. Take a look at their profile and respond from the Action Needed view to keep them engaged.`;
    const { html, text } = layout({
        eyebrow: "New applicant",
        headline: "You have a new applicant",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review candidate", url: `${APP_URL}/dashboard?view=actionNeeded` },
        footerNote: "Top professionals often accept other shifts within hours — quick responses dramatically improve your hire rate.",
    });
    return { subject, html, text };
}

export function shiftNoShow(ctx: ShiftContext): RenderedEmail {
    const subject = `No-show reported${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic reported that you did not appear for this scheduled shift. The DentiPal admin team has been notified and will review the report.`;
    const { html, text } = layout({
        eyebrow: "Attendance report",
        headline: "Shift marked as no-show",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Contact support", url: `${APP_URL}/professional/dashboard` },
        footerNote: "If you believe this report is incorrect — for example, you arrived but were not signed in — please contact DentiPal support right away with any supporting details.",
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
