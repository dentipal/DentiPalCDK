import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const SES_FROM = process.env.SES_FROM || "DentiPal Notifications <manoj.manukonda10@gmail.com>";

const ses = new SESClient({ region: REGION });

export interface SendArgs {
    to: string;
    subject: string;
    html: string;
    text: string;
}

export async function sendNotificationEmail(args: SendArgs): Promise<void> {
    if (!args.to || !args.to.includes("@")) {
        console.warn("[sendNotificationEmail] skipped — invalid recipient", { to: args.to });
        return;
    }
    try {
        await ses.send(new SendEmailCommand({
            Source: SES_FROM,
            Destination: { ToAddresses: [args.to] },
            Message: {
                Subject: { Data: args.subject, Charset: "UTF-8" },
                Body: {
                    Html: { Data: args.html, Charset: "UTF-8" },
                    Text: { Data: args.text, Charset: "UTF-8" },
                },
            },
        }));
        console.log("[sendNotificationEmail] sent", { to: args.to, subject: args.subject });
    } catch (err) {
        console.error("[sendNotificationEmail] SES send failed", {
            to: args.to,
            subject: args.subject,
            error: (err as Error).message,
        });
    }
}
