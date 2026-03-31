import axios from "axios";

// ============================================
// NipaMail Configuration
// ============================================
const NIPAMAIL_API_URL = "https://api.nipamail.com";

// Token cache (valid 1 hour, cache 55 min)
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Encode content to Base64
 */
function encodeToBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

/**
 * Get sender string in format: "Name <email>"
 */
function getSenderString(): string {
  const name = process.env.NIPAMAIL_SENDER_NAME || "The Pharmacy Council of Thailand";
  const email = process.env.NIPAMAIL_SENDER_EMAIL;
  if (!email) {
    throw new Error("NIPAMAIL_SENDER_EMAIL not configured");
  }
  return `${name} <${email}>`;
}

/**
 * Get NipaMail access token (with caching)
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.NIPAMAIL_CLIENT_ID;
  const clientSecret = process.env.NIPAMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "NipaMail credentials not configured. Set NIPAMAIL_CLIENT_ID and NIPAMAIL_CLIENT_SECRET in .env"
    );
  }

  try {
    const response = await axios.post(
      `${NIPAMAIL_API_URL}/v1/auth/tokens`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // Cache for 55 minutes
    return cachedToken!;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(
        `NipaMail auth failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

/**
 * Send email via NipaMail API
 */
async function sendNipaMailEmail(
  recipient: string,
  subject: string,
  text: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();

  // Convert plain text newlines to HTML line breaks for proper display
  const htmlContent = text.replace(/\n/g, '<br>\n');

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient: recipient,
          subject: subject,
          html: encodeToBase64(htmlContent),
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
  } catch (error: unknown) {
    // Retry once if token invalid (401)
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null; // Clear cache
      return sendNipaMailEmail(recipient, subject, text, false);
    }

    if (axios.isAxiosError(error) && error.response) {
      console.error(
        "NipaMail send failed:",
        JSON.stringify(error.response.data)
      );
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

/**
 * Send email via NipaMail API (raw HTML version)
 */
async function sendNipaMailHtml(
  recipient: string,
  subject: string,
  html: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient: recipient,
          subject: subject,
          html: encodeToBase64(html),
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
  } catch (error: unknown) {
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null;
      return sendNipaMailHtml(recipient, subject, html, false);
    }

    if (axios.isAxiosError(error) && error.response) {
      console.error(
        "NipaMail send failed:",
        JSON.stringify(error.response.data)
      );
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

/**
 * Get the conference website URL
 */
function getWebsiteUrl(): string {
  return process.env.BASE_URL || "https://conference-hub.org";
}

/**
 * Get the contact email
 */
function getContactEmail(): string {
  return process.env.CONTACT_EMAIL || "pr@pharmacycouncil.org";
}

// ============================================
// BACKWARD COMPATIBILITY WRAPPERS
// These functions call generic functions from emailTemplates.ts with default context
// They exist to maintain compatibility with existing route code
// TODO: Migrate routes to use generic functions directly, then remove these
// ============================================

import {
  sendEventRegistrationEmail,
  sendEventPaymentReceiptEmail,
  sendEventAbstractSubmissionEmail,
  sendEventCoAuthorNotificationEmail,
  sendEventAbstractAcceptedEmail,
  sendEventAbstractRejectedEmail,
  sendEventSignupNotificationEmail,
  sendEventPendingApprovalEmail,
  sendEventVerificationApprovedEmail,
  sendEventVerificationRejectedEmail,
  sendEventDocumentResubmittedEmail,
} from "./emailTemplates.js";
import { getDefaultEventEmailContext } from "./emailTemplates.types.js";

// Legacy wrapper: sendManualRegistrationEmail
export async function sendManualRegistrationEmail(
  email: string,
  firstName: string,
  lastName: string,
  regCode: string,
  eventName: string,
  ticketName: string,
  sessions: { sessionName: string; startTime: Date; endTime: Date }[]
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  // Override event name if provided
  ctx.eventName = eventName;
  await sendEventRegistrationEmail(email, firstName, lastName, regCode, ticketName, sessions, ctx);
}

// Legacy wrapper: sendAbstractSubmissionEmail
export async function sendAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  trackingId: string,
  abstractTitle: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventAbstractSubmissionEmail(email, firstName, lastName, trackingId, abstractTitle, ctx);
}

// Legacy wrapper: sendCoAuthorNotificationEmail
export async function sendCoAuthorNotificationEmail(
  email: string,
  firstName: string,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventCoAuthorNotificationEmail(email, firstName, lastName, mainAuthorName, trackingId, abstractTitle, ctx);
}

// Legacy wrapper: sendAbstractAcceptedPosterEmail
export async function sendAbstractAcceptedPosterEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  comment?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventAbstractAcceptedEmail(email, firstName, lastName, abstractTitle, "poster", ctx, comment);
}

// Legacy wrapper: sendAbstractAcceptedOralEmail
export async function sendAbstractAcceptedOralEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  comment?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventAbstractAcceptedEmail(email, firstName, lastName, abstractTitle, "oral", ctx, comment);
}

// Legacy wrapper: sendAbstractRejectedEmail
export async function sendAbstractRejectedEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  comment?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventAbstractRejectedEmail(email, firstName, lastName, abstractTitle, ctx, comment);
}

// Legacy wrapper: sendPendingApprovalEmail
export async function sendPendingApprovalEmail(
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventPendingApprovalEmail(email, firstName, lastName, ctx);
}

// Legacy wrapper: sendSignupNotificationEmail
export async function sendSignupNotificationEmail(
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventSignupNotificationEmail(email, firstName, lastName, ctx);
}

// Legacy wrapper: sendVerificationApprovedEmail
export async function sendVerificationApprovedEmail(
  email: string,
  firstName: string,
  comment?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventVerificationApprovedEmail(email, firstName, ctx, comment);
}

// Legacy wrapper: sendVerificationRejectedEmail
export async function sendVerificationRejectedEmail(
  email: string,
  firstName: string,
  lastName: string,
  rejectionReason?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventVerificationRejectedEmail(email, firstName, lastName, ctx, rejectionReason);
}

// Legacy wrapper: sendDocumentResubmittedEmail
export async function sendDocumentResubmittedEmail(
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventDocumentResubmittedEmail(email, firstName, lastName, ctx);
}

interface ReceiptEmailItem {
  name: string;
  type: string;
  price: number;
}

interface TaxInvoiceEmailInfo {
  taxName: string | null;
  taxId: string | null;
  taxFullAddress: string | null;
}

// Legacy wrapper: sendPaymentReceiptEmail
export async function sendPaymentReceiptEmail(
  email: string,
  firstName: string,
  lastName: string,
  orderNumber: string,
  paidAt: Date,
  paymentChannel: string,
  items: ReceiptEmailItem[],
  subtotal: number,
  fee: number,
  total: number,
  currency: string,
  receiptDownloadUrl: string,
  taxInvoice?: TaxInvoiceEmailInfo,
  regCode?: string
): Promise<void> {
  const ctx = getDefaultEventEmailContext();
  await sendEventPaymentReceiptEmail(
    email, firstName, lastName, orderNumber, paidAt, paymentChannel,
    items, subtotal, fee, total, currency, receiptDownloadUrl, ctx, taxInvoice, regCode
  );
}


// ============================================
// PASSWORD RESET EMAIL
// ============================================

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  firstName: string,
  resetToken: string
): Promise<void> {
  const resetUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/reset-password?token=${resetToken}`
    : `http://localhost:3000/reset-password?token=${resetToken}`;

  const plainText = `
Dear ${firstName},

We received a request to reset your password for your account.

Click the link below to create a new password:
${resetUrl}

This link will expire in 1 hour. If you didn't request this, please ignore this email.

Sincerely,
The Pharmacy Council of Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Reset Your Password", plainText);
    console.log(`Password reset email sent to ${email}`);
  } catch (error) {
    console.error("Error sending password reset email:", error);
    throw error;
  }
}

// ============================================
// LEGACY: Payment Receipt Email removed
// Use sendEventPaymentReceiptEmail from emailTemplates.ts
// ============================================

// ============================================
// CONTACT FORM EMAIL
// ============================================

/**
 * Send contact form email to conference organizers
 * Email will be sent to CONTACT_FORM_EMAIL env variable
 */
export async function sendContactFormEmail(
  name: string,
  email: string,
  phone: string,
  subject: string,
  message: string
): Promise<void> {
  const targetEmail = process.env.CONTACT_FORM_EMAIL || "pr@pharmacycouncil.org";

  const plainText = `
New Contact Form Submission

From: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}

Subject: ${subject}

Message:
${message}

---
This message was sent via the conference website contact form.
  `.trim();

  try {
    await sendNipaMailEmail(targetEmail, `[Contact Form] ${subject}`, plainText);
    console.log(`Contact form email sent from ${email} to ${targetEmail}`);
  } catch (error) {
    console.error("Error sending contact form email:", error);
    throw error;
  }
}
