// Sending through Gmail's SMTP with the app password. Server only.
// Gmail saves a copy of everything sent this way in "Sent Mail" by itself.
// Dry run (MAIL_DRY_RUN=1) builds the email with nodemailer's jsonTransport
// and sends nothing.

import nodemailer from 'nodemailer';
import { FROM_NAME } from './config.js';

export function createSmtp({ user, pass, dryRun = false }) {
  const transport = dryRun
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: { user, pass: String(pass || '').replace(/\s+/g, '') },
        pool: true,
        maxConnections: 1,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        logger: false
      });
  return {
    dryRun,
    // auto: an automatic reply (RFC 3834 headers so other robots don't answer it).
    async send({ to, subject, text, inReplyTo, references, messageId, auto = false }) {
      const headers = auto ? { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' } : {};
      const info = await transport.sendMail({
        from: { name: FROM_NAME, address: user },
        to,
        subject,
        text,
        inReplyTo,
        references,
        messageId,
        headers
      });
      return { messageId: info.messageId || messageId, dryRun };
    },
    close() {
      try {
        transport.close();
      } catch {
        // ignore
      }
    }
  };
}

// 'definite': the email certainly did not go out (safe to retry).
// 'unclear': it may have gone out. The sync then checks Sent Mail before
// trying again, so nobody gets the same email twice.
export function classifySmtpError(err) {
  if (!err) return 'unclear';
  if (err.responseCode) return 'definite'; // the server answered with a rejection
  if (['EAUTH', 'EDNS', 'EENVELOPE', 'EMESSAGE', 'ETLS', 'EOAUTH2'].includes(err.code)) return 'definite';
  // A connection that closed before anything was sent.
  if (err.code === 'ECONNECTION' && err.command === 'API') return 'definite';
  return 'unclear';
}

export function describeSmtpError(err) {
  if (!err) return '';
  if (err.code === 'EAUTH') return 'Gmail refused the login for sending. Check the app password.';
  if (err.responseCode) return `Gmail rejected the email (${err.responseCode}).`;
  return `Sending failed${err.code ? ` (${err.code})` : ''}.`;
}
