import { Resend } from "resend";

// Email is optional. If RESEND_API_KEY is missing, sendEmail() logs and
// returns false instead of throwing. This keeps all callers simple.

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL;
}

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(params: SendEmailParams): Promise<boolean> {
  if (!isEmailConfigured()) {
    console.log(
      `[email:skipped] to=${params.to} subject="${params.subject}" ` +
        `(set RESEND_API_KEY + RESEND_FROM_EMAIL to enable)`
    );
    return false;
  }

  try {
    await getResend().emails.send({
      from: process.env.RESEND_FROM_EMAIL!,
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
    return true;
  } catch (err) {
    console.error("[email:error]", err);
    return false;
  }
}
