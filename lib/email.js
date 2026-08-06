const { Resend } = require('resend');

const FROM = process.env.EMAIL_FROM || 'RezDev <noreply@rezdevos.com>';
const APP_URL = process.env.FRONTEND_URL || 'https://rezdevos.com';

const DOCS_BASE = "https://nuljmkryxqdowvlcagmq.supabase.co/storage/v1/object/public/Docs";
const GUIDE_URL = DOCS_BASE + "/RezDev_Client_Portal_Guide.pdf";
const FAQ_URL = DOCS_BASE + "/RezDev_Client_Portal_FAQ.pdf";

// Lazily create the Resend client so a missing key never crashes the app at boot.
let _resend = null;
function getResend(){
  if(_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if(!key) throw new Error('RESEND_API_KEY is not configured');
  _resend = new Resend(key);
  return _resend;
}

// Branded client invite email
async function sendClientInvite({ to, clientName, builderName, companyName, setupUrl, role }){
  const name = clientName || 'there';
  const company = companyName || 'your builder';
  const roleMeta = {
    client: { portal: 'client portal', blurb: "follow your project's progress, view your schedule and finances, review selections, approve change orders, and message your builder", sub: 'Client Portal' },
    pm:     { portal: 'project management portal', blurb: "manage your assigned projects — schedules, budgets, phases, contractors, and client communication", sub: 'Project Management' },
    builder:{ portal: 'builder portal', blurb: 'manage your projects, schedules, budgets, and team', sub: 'Builder Portal' },
  };
  const meta = roleMeta[role] || roleMeta.client;
  const subject = `You've been invited to the ${company} ${meta.portal}`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border-radius:14px 14px 0 0;padding:30px 32px;text-align:center;border-bottom:1px solid #e3e8ee;">
      <img src="https://nuljmkryxqdowvlcagmq.supabase.co/storage/v1/object/public/logos/rezdev_full_logo.png" alt="RezDev" height="56" style="height:56px;width:auto;max-width:240px;"/>
      <div style="color:#6b7280;font-size:12px;margin-top:8px;">${meta.sub}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06);">
      <p style="font-size:16px;color:#0C2340;margin:0 0 16px;">Hi ${name},</p>
      <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 16px;">
        ${builderName ? builderName+' at ' : ''}${company} has invited you to your ${meta.portal}, where you can ${meta.blurb}.
      </p>
      <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 24px;">Click below to set your password and get started:</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${setupUrl}" style="display:inline-block;background:#128995;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 32px;border-radius:9px;">Set Up My Account</a>
      </div>
      <p style="font-size:12.5px;color:#6b7280;line-height:1.6;margin:0;">If the button doesn't work, copy and paste this link into your browser:<br><a href="${setupUrl}" style="color:#128995;word-break:break-all;">${setupUrl}</a></p>
      <div style="border-top:1px solid #e3e8ee;padding-top:20px;margin-top:22px;">
        <p style="font-size:13px;color:#0C2340;font-weight:600;margin:0 0 10px;">Helpful resources</p>
        <p style="font-size:13px;color:#374151;line-height:1.6;margin:0 0 12px;">New to the portal? These short guides walk you through everything:</p>
        <p style="margin:0 0 8px;"><a href="${GUIDE_URL}" style="color:#128995;text-decoration:none;font-size:13.5px;font-weight:600;">Client Portal Guide (PDF)</a></p>
        <p style="margin:0;"><a href="${FAQ_URL}" style="color:#128995;text-decoration:none;font-size:13.5px;font-weight:600;">Frequently Asked Questions (PDF)</a></p>
      </div>
    </div>
    <div style="text-align:center;padding:18px 0;color:#9ca3af;font-size:11px;">Powered by RezDev &middot; Construction Management</div>
  </div>
</body></html>`;

  return getResend().emails.send({ from: FROM, to, subject, html });
}

// Shared branded shell for simple notification emails.
function notificationHtml({ heading, bodyLines, ctaLabel, ctaUrl, subLabel }){
  const lines = (bodyLines || []).map(t =>
    `<p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 16px;">${t}</p>`
  ).join('');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px;">
    <div style="background:#ffffff;border-radius:14px 14px 0 0;padding:30px 32px;text-align:center;border-bottom:1px solid #e3e8ee;">
      <img src="https://nuljmkryxqdowvlcagmq.supabase.co/storage/v1/object/public/logos/rezdev_full_logo.png" alt="RezDev" height="56" style="height:56px;width:auto;max-width:240px;"/>
      <div style="color:#6b7280;font-size:12px;margin-top:8px;">${subLabel || ''}</div>
    </div>
    <div style="background:#fff;border-radius:0 0 14px 14px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,.06);">
      <p style="font-size:18px;color:#0C2340;font-weight:700;margin:0 0 18px;">${heading}</p>
      ${lines}
      <div style="text-align:center;margin:8px 0 8px;">
        <a href="${ctaUrl}" style="display:inline-block;background:#128995;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:13px 32px;border-radius:9px;">${ctaLabel}</a>
      </div>
    </div>
    <div style="text-align:center;padding:18px 0;color:#9ca3af;font-size:11px;">Powered by RezDev &middot; Construction Management</div>
  </div>
</body></html>`;
}

// Notify a client that a contract is waiting for their signature in the portal.
async function sendContractNotification({ to, clientName, builderName, companyName, projectName }){
  if(!to) return null;
  const company = companyName || 'your builder';
  const subject = `Your signature is requested${projectName ? ' — ' + projectName : ''}`;
  const html = notificationHtml({
    subLabel: 'Contract for signature',
    heading: 'You have a document to sign',
    bodyLines: [
      `Hi ${clientName || 'there'},`,
      `${builderName ? builderName + ' at ' : ''}${company} has sent you a document that needs your signature${projectName ? ' for ' + projectName : ''}.`,
      'Sign in to your client portal to review and sign it.',
    ],
    ctaLabel: 'Open My Portal',
    ctaUrl: APP_URL,
  });
  return getResend().emails.send({ from: FROM, to, subject, html });
}

// Notify the other party that a new message was posted in a project (no content included).
async function sendMessageNotification({ to, recipientName, senderName, projectName }){
  if(!to) return null;
  const subject = `New message${projectName ? ' — ' + projectName : ''}`;
  const html = notificationHtml({
    subLabel: 'New message',
    heading: 'You have a new message',
    bodyLines: [
      `Hi ${recipientName || 'there'},`,
      `${senderName || 'Someone'} sent you a new message${projectName ? ' on ' + projectName : ''}.`,
      'Sign in to view and reply.',
    ],
    ctaLabel: 'View Message',
    ctaUrl: APP_URL,
  });
  return getResend().emails.send({ from: FROM, to, subject, html });
}

module.exports = { sendClientInvite, sendContractNotification, sendMessageNotification };
