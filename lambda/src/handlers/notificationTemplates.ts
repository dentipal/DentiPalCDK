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
    headline: string;
    intro: string;
    detailRows: Array<[string, string]>;
    footerNote?: string;
    cta: { label: string; url: string };
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
    const detailHtml = input.detailRows.map(([k, v]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#777;font-size:13px;">${escapeHtml(k)}</td>` +
        `<td style="padding:6px 0;color:#333;font-size:14px;font-weight:500;">${escapeHtml(v)}</td></tr>`
    ).join("");

    const detailText = input.detailRows.map(([k, v]) => `${k}: ${v}`).join("\n");

    const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#faf6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf6f4;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.04);">
        <tr><td style="background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);padding:24px 32px;">
          <h1 style="margin:0;color:#532b21;font-size:20px;font-weight:700;">DentiPal</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          <h2 style="margin:0 0 12px;color:#222;font-size:22px;font-weight:600;">${escapeHtml(input.headline)}</h2>
          <p style="margin:0 0 20px;color:#555;font-size:15px;line-height:1.5;">${escapeHtml(input.intro)}</p>
          ${input.detailRows.length > 0
            ? `<table cellpadding="0" cellspacing="0" style="margin:0 0 24px;border-top:1px solid #f0e8e4;border-bottom:1px solid #f0e8e4;width:100%;">${detailHtml}</table>`
            : ""}
          <p style="margin:0 0 28px;text-align:center;">
            <a href="${input.cta.url}" style="display:inline-block;background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);color:#532b21;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;text-decoration:none;">${escapeHtml(input.cta.label)}</a>
          </p>
          ${input.footerNote ? `<p style="margin:0;color:#888;font-size:13px;line-height:1.5;">${escapeHtml(input.footerNote)}</p>` : ""}
        </td></tr>
        <tr><td style="background:#faf6f4;padding:20px 32px;border-top:1px solid #f0e8e4;">
          <p style="margin:0;color:#999;font-size:12px;line-height:1.5;">
            You're receiving this because you have notifications enabled in DentiPal.
            Manage notification preferences in your <a href="${APP_URL}/professional/profile" style="color:#a36556;">DentiPal settings</a>.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

    const text = [
        "DentiPal",
        "",
        input.headline,
        "",
        input.intro,
        "",
        detailText,
        "",
        `${input.cta.label}: ${input.cta.url}`,
        ...(input.footerNote ? ["", input.footerNote] : []),
        "",
        "—",
        `Manage notification preferences: ${APP_URL}/professional/profile`,
    ].filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n");

    return { html, text };
}

function greeting(name?: string): string {
    return name ? `Hi ${name},` : "Hi there,";
}

export function shiftScheduled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift confirmed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} your application has been accepted. Here are your shift details.`;
    const { html, text } = layout({
        headline: "Shift confirmed",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift in DentiPal", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Make sure to arrive on time. Reply to your clinic via DentiPal chat if anything changes.",
    });
    return { subject, html, text };
}

export function applicationRejected(ctx: ShiftContext): RenderedEmail {
    const subject = `Update on your application${ctx.role ? ` for ${ctx.role}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has decided to move forward with another candidate for this role. Don't be discouraged — there are more shifts on DentiPal.`;
    const { html, text } = layout({
        headline: "Application update",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Browse open shifts", url: `${APP_URL}/professional/dashboard` },
    });
    return { subject, html, text };
}

export function inviteSent(ctx: ShiftContext): RenderedEmail {
    const subject = `${ctx.clinicName || "A clinic"} invited you to apply${ctx.role ? ` — ${ctx.role}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} ${ctx.clinicName || "a clinic"} has invited you to apply for an upcoming shift.`;
    const { html, text } = layout({
        headline: "You've been invited",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review invitation", url: `${APP_URL}/professional/invites` },
        footerNote: "Invitations are time-sensitive — respond soon to lock it in.",
    });
    return { subject, html, text };
}

export function shiftCancelled(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift cancelled${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has cancelled this scheduled shift.`;
    const { html, text } = layout({
        headline: "Shift cancelled",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Browse other shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "We're sorry for the inconvenience. New shifts are posted daily.",
    });
    return { subject, html, text };
}

export function shiftEdited(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift details updated${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has updated the details of your scheduled shift. Please review the latest below.`;
    const { html, text } = layout({
        headline: "Shift details updated",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View updated shift", url: `${APP_URL}/professional/scheduled-shifts` },
    });
    return { subject, html, text };
}

export function shiftReminderH24(ctx: ShiftContext): RenderedEmail {
    const subject = `Reminder: shift tomorrow${ctx.startTime ? ` at ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} this is a reminder about your shift coming up in ~24 hours.`;
    const { html, text } = layout({
        headline: "Shift tomorrow",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "View shift details", url: `${APP_URL}/professional/scheduled-shifts` },
        footerNote: "Plan your route and confirm any pre-shift requirements with the clinic.",
    });
    return { subject, html, text };
}

export function shiftReminderH1(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift starting soon${ctx.startTime ? ` at ${ctx.startTime}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} your shift starts in about an hour. Time to head out.`;
    const { html, text } = layout({
        headline: "Shift starting soon",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Open DentiPal", url: `${APP_URL}/professional/scheduled-shifts` },
    });
    return { subject, html, text };
}

export function shiftCompleted(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift completed${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has confirmed your completed shift. Thanks for the great work.`;
    const detailRows = detailLines(ctx);
    if (ctx.actualHoursWorked !== undefined && ctx.actualHoursWorked !== null && ctx.actualHoursWorked !== "") {
        detailRows.push(["Hours worked", `${ctx.actualHoursWorked}h`]);
    }
    const { html, text } = layout({
        headline: "Shift completed",
        intro,
        detailRows,
        cta: { label: "View completed shifts", url: `${APP_URL}/professional/dashboard` },
        footerNote: "Payment is processed by the clinic per their normal cycle. Reach out to support if anything looks off.",
    });
    return { subject, html, text };
}

export function applicationReceived(ctx: ShiftContext): RenderedEmail {
    const who = ctx.professionalName?.trim() || "A professional";
    const subject = `New applicant${ctx.role ? ` for your ${ctx.role} shift` : ""}`;
    const intro = `${who} just applied to your shift${ctx.role ? ` for ${ctx.role}` : ""}. Review their profile and respond from the Action Needed view.`;
    const { html, text } = layout({
        headline: "New applicant",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Review candidates", url: `${APP_URL}/dashboard?view=actionNeeded` },
        footerNote: "Strong candidates often get hired within hours — quick responses help you secure them.",
    });
    return { subject, html, text };
}

export function shiftNoShow(ctx: ShiftContext): RenderedEmail {
    const subject = `Shift marked as no-show${ctx.date ? ` — ${ctx.date}` : ""}`;
    const intro = `${greeting(ctx.professionalName)} the clinic has reported that you did not appear for this scheduled shift. The DentiPal admin team has been notified and will review.`;
    const { html, text } = layout({
        headline: "Shift marked as no-show",
        intro,
        detailRows: detailLines(ctx),
        cta: { label: "Open DentiPal", url: `${APP_URL}/professional/dashboard` },
        footerNote: "If you believe this is incorrect, please contact DentiPal support so the admin team can review.",
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
