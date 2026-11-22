import nodemailer from "nodemailer";

type AuthEmail = { to: string; subject: string; text: string; html: string };

function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT ?? "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: user && pass ? { user, pass } : undefined });
}

export function isAuthEmailConfigured() {
  const port = Number(process.env.SMTP_PORT ?? "587");
  return Boolean(process.env.AUTH_EMAIL_FROM && process.env.SMTP_HOST && Number.isInteger(port) && port >= 1 && port <= 65535);
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export async function sendAuthEmail(message: AuthEmail) {
  const from = process.env.AUTH_EMAIL_FROM;
  const transport = createTransport();
  if (transport && from) {
    await transport.sendMail({ from, ...message });
    return;
  }
  throw new Error("AUTH_EMAIL_UNAVAILABLE: configure AUTH_EMAIL_FROM, SMTP_HOST, SMTP_PORT, and valid SMTP settings before sending auth email");
}
