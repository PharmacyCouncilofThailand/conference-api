import axios from "axios";
import type { EventEmailContext } from "./emailTemplates.types.js";

// ============================================
// NipaMail Configuration (shared with emailService.ts)
// ============================================
const NIPAMAIL_API_URL = "https://api.nipamail.com";

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

function encodeToBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

function getSenderString(): string {
  const name = process.env.NIPAMAIL_SENDER_NAME || "The Pharmacy Council of Thailand";
  const email = process.env.NIPAMAIL_SENDER_EMAIL;
  if (!email) {
    throw new Error("NIPAMAIL_SENDER_EMAIL not configured");
  }
  return `${name} <${email}>`;
}

async function getAccessToken(): Promise<string> {
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
    tokenExpiry = Date.now() + 55 * 60 * 1000;
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

async function sendNipaMailEmail(
  recipient: string,
  subject: string,
  text: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();
  const htmlContent = text.replace(/\n/g, "<br>\n");

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient,
          subject,
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
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null;
      return sendNipaMailEmail(recipient, subject, text, false);
    }
    if (axios.isAxiosError(error) && error.response) {
      console.error("NipaMail send failed:", JSON.stringify(error.response.data));
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

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
          recipient,
          subject,
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
      console.error("NipaMail send failed:", JSON.stringify(error.response.data));
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

// ============================================
// Shared helpers
// ============================================

/** Standard return shape for content builders (used by render endpoint for preview) */
export interface EventEmailContent {
  subject: string;
  html: string;
}

/** Convert plain text email to HTML by replacing newlines with <br> */
function textToHtml(text: string): string {
  return text.replace(/\n/g, "<br>\n");
}

/** Build email signature block */
function signature(_ctx: EventEmailContext): string {
  return `Sincerely,\nThe Pharmacy Council of Thailand`;
}

/** Build the standard conference intro line */
function introLine(ctx: EventEmailContext): string {
  return `The meeting will take place ${ctx.dates}, at ${ctx.venue}.`;
}

// ============================================
// 1. EVENT REGISTRATION EMAIL (Generic version of sendManualRegistrationEmail)
// ============================================

export function buildEventRegistrationEmailContent(
  firstName: string,
  lastName: string,
  regCode: string,
  ticketName: string,
  sessions: { sessionName: string; startTime: Date; endTime: Date }[],
  ctx: EventEmailContext
): EventEmailContent {
  const sessionLines =
    sessions.length > 0
      ? sessions
          .map((s) => {
            const date = s.startTime.toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              timeZone: "Asia/Bangkok",
            });
            const timeFrom = s.startTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Bangkok",
            });
            const timeTo = s.endTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Bangkok",
            });
            return `  - ${s.sessionName} (${date}, ${timeFrom} - ${timeTo})`;
          })
          .join("\n")
      : "  - (No sessions)";

  const plainText = `
Dear ${firstName} ${lastName},

Your registration for the ${ctx.eventName} has been confirmed. ${introLine(ctx)}

Registration Code: ${regCode}
Event: ${ctx.eventName}
Ticket: ${ticketName}

Registered Sessions:
${sessionLines}

Please present this registration code (or scan the QR code below) at the registration desk on the day of the event.

For more information and details about the conference, go to ${ctx.websiteUrl}

If you have any questions, please contact pr@pharmacycouncil.org

See you soon at ${ctx.shortName}.

${signature(ctx)}
  `.trim();

  let html = textToHtml(plainText);

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`;
  const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR Code: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /><p style="font-size:13px;color:#6b7280;margin-top:8px;">Scan this QR code at the registration desk for fast check-in</p></div>`;

  html = html.replace(
    `Registration Code: ${regCode}`,
    `Registration Code: <strong>${regCode}</strong>${qrHtml}`
  );

  return {
    subject: `Registration Confirmed - ${ctx.shortName}`,
    html,
  };
}

export async function sendEventRegistrationEmail(
  email: string,
  firstName: string,
  lastName: string,
  regCode: string,
  ticketName: string,
  sessions: { sessionName: string; startTime: Date; endTime: Date }[],
  ctx: EventEmailContext
): Promise<void> {
  const { subject, html } = buildEventRegistrationEmailContent(
    firstName, lastName, regCode, ticketName, sessions, ctx
  );

  try {
    await sendNipaMailHtml(email, subject, html);
    console.log(`[Generic] Registration email sent to ${email} [${regCode}]`);
  } catch (error) {
    console.error("[Generic] Error sending registration email:", error);
    throw error;
  }
}

// ============================================
// 2. EVENT PAYMENT RECEIPT EMAIL (Generic version of sendPaymentReceiptEmail)
// ============================================

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

export function buildEventPaymentReceiptEmailContent(
  firstName: string,
  lastName: string,
  orderNumber: string,
  paidAt: Date,
  paymentChannel: string,
  items: ReceiptEmailItem[],
  _subtotal: number,
  fee: number,
  total: number,
  currency: string,
  receiptDownloadUrl: string,
  ctx: EventEmailContext,
  taxInvoice?: TaxInvoiceEmailInfo,
  regCode?: string
): EventEmailContent {
  const currencySymbol = currency === "THB" ? "\u0E3F" : "$";
  const methodLabel =
    paymentChannel === "promptpay" ? "PromptPay (QR)" : "Credit/Debit Card";

  const dateStr = paidAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });

  const itemLines = items
    .map((item) => `  - ${item.name}: ${currencySymbol}${item.price.toLocaleString()}`)
    .join("\n");

  const feeLineText =
    fee > 0
      ? `  - Payment Processing Fee: ${currencySymbol}${fee.toLocaleString()}\n`
      : "";

  const taxInvoiceText = taxInvoice
    ? `
Tax Invoice Details:
Name: ${taxInvoice.taxName || "-"}
Tax ID: ${taxInvoice.taxId || "-"}
Tax Address: ${taxInvoice.taxFullAddress || "-"}`
    : "";

  const qrUrl = regCode
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`
    : "";

  const plainText = `
Dear ${firstName} ${lastName},

Thank you for your registration and payment for the ${ctx.eventName}. ${introLine(ctx)}

Your registration has been confirmed. Below is your payment summary:

Order Number: ${orderNumber}
Payment Date: ${dateStr}
Payment Method: ${methodLabel}

Items:
${itemLines}
${feeLineText}
Total Paid: ${currencySymbol}${total.toLocaleString()}
${taxInvoiceText}
${regCode ? `\nRegistration Code: ${regCode}\nPresent this QR code at the event for check-in.` : ""}

Download your receipt (PDF): ${receiptDownloadUrl}

For more information and details about the conference, go to ${ctx.websiteUrl}

If you have any questions, please contact pr@pharmacycouncil.org

See you soon at ${ctx.shortName}.

${signature(ctx)}
  `.trim();

  let html = textToHtml(plainText);

  html = html.replace(
    `Download your receipt (PDF): ${receiptDownloadUrl}`,
    `Download your receipt (PDF): <a href="${receiptDownloadUrl}" style="color: #1a73e8; font-weight: bold; text-decoration: underline;">Download Here</a>`
  );

  if (qrUrl && regCode) {
    const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR Code: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /></div>`;
    html = html.replace(
      `Registration Code: ${regCode}`,
      `Registration Code: <strong>${regCode}</strong>${qrHtml}`
    );
  }

  return {
    subject: `Payment Receipt - ${orderNumber} | ${ctx.shortName}`,
    html,
  };
}

export async function sendEventPaymentReceiptEmail(
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
  ctx: EventEmailContext,
  taxInvoice?: TaxInvoiceEmailInfo,
  regCode?: string
): Promise<void> {
  const { subject, html } = buildEventPaymentReceiptEmailContent(
    firstName, lastName, orderNumber, paidAt, paymentChannel, items,
    subtotal, fee, total, currency, receiptDownloadUrl, ctx, taxInvoice, regCode,
  );

  try {
    await sendNipaMailHtml(email, subject, html);
    console.log(`[Generic] Payment receipt email sent to ${email} for order ${orderNumber}`);
  } catch (error) {
    console.error("[Generic] Error sending payment receipt email:", error);
    throw error;
  }
}

// ============================================
// 3. ABSTRACT SUBMISSION EMAIL
// ============================================

export function buildEventAbstractSubmissionEmailContent(
  firstName: string,
  lastName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  presentationType?: string,
): EventEmailContent {
  const typeLabel = presentationType === "oral" ? "Oral Presentation" : presentationType === "poster" ? "Poster Presentation" : "Presentation";

  const plainText = `
Dear ${firstName} ${lastName},

Thank you for submitting your abstract for ${typeLabel} at the ${ctx.eventName}. ${introLine(ctx)}

We have received your abstract and will notify you of the acceptance result within 2 weeks after the submission deadline.

Tracking ID: ${trackingId}
Abstract Title: ${abstractTitle}
Presentation Type: ${typeLabel}

If you have any questions, please contact pr@pharmacycouncil.org

${signature(ctx)}
  `.trim();

  return {
    subject: `Abstract Submission Received - ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  presentationType?: string,
): Promise<void> {
  const { subject } = buildEventAbstractSubmissionEmailContent(
    firstName, lastName, trackingId, abstractTitle, ctx, presentationType
  );

  // Reconstruct the plain-text version (NipaMail text endpoint already converts \n -> <br>)
  const typeLabel = presentationType === "oral" ? "Oral Presentation" : presentationType === "poster" ? "Poster Presentation" : "Presentation";
  const plainText = `
Dear ${firstName} ${lastName},

Thank you for submitting your abstract for ${typeLabel} at the ${ctx.eventName}. ${introLine(ctx)}

We have received your abstract and will notify you of the acceptance result within 2 weeks after the submission deadline.

Tracking ID: ${trackingId}
Abstract Title: ${abstractTitle}
Presentation Type: ${typeLabel}

If you have any questions, please contact pr@pharmacycouncil.org

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, subject, plainText);
    console.log(`[Generic] Abstract submission email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending abstract submission email:", error);
    throw error;
  }
}

// ============================================
// 4. CO-AUTHOR NOTIFICATION EMAIL
// ============================================

function buildCoAuthorPlainText(
  firstName: string,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext
): string {
  return `
Dear ${firstName} ${lastName},

We would like to notify you that your co-authored abstract, titled "${abstractTitle}", has been submitted to the ${ctx.eventName}. ${introLine(ctx)}

Tracking ID: ${trackingId}
Submitted by: ${mainAuthorName}

${signature(ctx)}
  `.trim();
}

export function buildEventCoAuthorNotificationEmailContent(
  firstName: string,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext
): EventEmailContent {
  const plainText = buildCoAuthorPlainText(firstName, lastName, mainAuthorName, trackingId, abstractTitle, ctx);
  return {
    subject: `Co-Author Notification - ${ctx.shortName} Abstract`,
    html: textToHtml(plainText),
  };
}

export async function sendEventCoAuthorNotificationEmail(
  email: string,
  firstName: string,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = buildCoAuthorPlainText(firstName, lastName, mainAuthorName, trackingId, abstractTitle, ctx);

  try {
    await sendNipaMailEmail(email, `Co-Author Notification - ${ctx.shortName} Abstract`, plainText);
    console.log(`[Generic] Co-author notification email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending co-author notification email:", error);
    throw error;
  }
}

// ============================================
// 5. ABSTRACT ACCEPTED EMAIL (poster + oral unified)
// ============================================

function buildAbstractAcceptedPlainText(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  presentationType: "poster" | "oral",
  ctx: EventEmailContext,
  comment?: string
): string {
  const typeLabel = presentationType === "poster" ? "POSTER PRESENTATION" : "ORAL PRESENTATION";
  const articlePrefix = presentationType === "poster" ? "a" : "an";
  const commentText = comment ? `\nComment: ${comment}\n` : "";

  return `
Dear ${firstName} ${lastName},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as ${articlePrefix} ${typeLabel} at the ${ctx.eventName}. ${introLine(ctx)}
${commentText}
All ${presentationType} presenters must be registered for the meeting in order to present${presentationType === "poster" ? " their poster" : ""}. For registration information and details go to ${ctx.websiteUrl}

We look forward to your presentation. If you have any questions, please contact pr@pharmacycouncil.org

${signature(ctx)}
  `.trim();
}

export function buildEventAbstractAcceptedEmailContent(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  presentationType: "poster" | "oral",
  ctx: EventEmailContext,
  comment?: string
): EventEmailContent {
  const plainText = buildAbstractAcceptedPlainText(firstName, lastName, abstractTitle, presentationType, ctx, comment);
  return {
    subject: `Congratulations! Abstract Accepted (${presentationType === "poster" ? "Poster" : "Oral"}) - ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventAbstractAcceptedEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  presentationType: "poster" | "oral",
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const plainText = buildAbstractAcceptedPlainText(firstName, lastName, abstractTitle, presentationType, ctx, comment);

  try {
    await sendNipaMailEmail(
      email,
      `Congratulations! Abstract Accepted (${presentationType === "poster" ? "Poster" : "Oral"}) - ${ctx.shortName}`,
      plainText
    );
    console.log(`[Generic] Abstract accepted (${presentationType}) email sent to ${email}`);
  } catch (error) {
    console.error(`[Generic] Error sending abstract accepted (${presentationType}) email:`, error);
    throw error;
  }
}

// ============================================
// 6. ABSTRACT REJECTED EMAIL
// ============================================

function buildAbstractRejectedPlainText(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  comment?: string
): string {
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  return `
Dear ${firstName} ${lastName},

Thank you very much for submitting your abstract for poster or oral presentation at the ${ctx.eventName}. Unfortunately, there are many high-quality abstracts, but we still have limited availability for poster or oral presentations.

Abstract Title: ${abstractTitle}
${commentText}
Thank you so much again for your submission. Looking forward to your abstract at next year's conference.

${signature(ctx)}
  `.trim();
}

export function buildEventAbstractRejectedEmailContent(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  comment?: string
): EventEmailContent {
  const plainText = buildAbstractRejectedPlainText(firstName, lastName, abstractTitle, ctx, comment);
  return {
    subject: `Abstract Submission Update - ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventAbstractRejectedEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const plainText = buildAbstractRejectedPlainText(firstName, lastName, abstractTitle, ctx, comment);

  try {
    await sendNipaMailEmail(email, `Abstract Submission Update - ${ctx.shortName}`, plainText);
    console.log(`[Generic] Abstract rejected email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending abstract rejected email:", error);
    throw error;
  }
}

// ============================================
// 7. SIGNUP NOTIFICATION EMAIL (non-student auto-approved)
// ============================================

// Signup is platform-level (account creation), not tied to any specific event,
// so the email uses a generic "Conference Hub" brand and omits dates/venue.
const SIGNUP_SUBJECT = "Welcome to Conference Hub - Registration Successful";

function buildSignupPlainText(firstName: string, lastName: string, ctx: EventEmailContext): string {
  return `
Dear ${firstName} ${lastName},

Welcome to Conference Hub.

Thank you for creating your account with the Pharmacy Council of Thailand. Your account is now ready, and you can browse upcoming conferences, register for events, and submit abstracts at any time.

We look forward to seeing you at our upcoming events.

If you have any questions, please feel free to contact us at pr@pharmacycouncil.org.

${signature(ctx)}
  `.trim();
}

export function buildEventSignupNotificationEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext
): EventEmailContent {
  return {
    subject: SIGNUP_SUBJECT,
    html: textToHtml(buildSignupPlainText(firstName, lastName, ctx)),
  };
}

export async function sendEventSignupNotificationEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = buildSignupPlainText(firstName, lastName, ctx);

  try {
    await sendNipaMailEmail(email, SIGNUP_SUBJECT, plainText);
    console.log(`[Generic] Signup notification email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending signup notification email:", error);
    throw error;
  }
}

// ============================================
// 8. PENDING APPROVAL EMAIL (student document verification)
// ============================================

// Pending approval is also platform-level (sent at student signup before event registration).
const PENDING_APPROVAL_SUBJECT =
  "Welcome to Conference Hub - Document Verification Pending";

function buildPendingApprovalPlainText(firstName: string, lastName: string, ctx: EventEmailContext): string {
  return `
Dear ${firstName} ${lastName},

Welcome to Conference Hub.

Thank you for creating your student account with the Pharmacy Council of Thailand. To confirm your eligibility for student rates, our team is currently reviewing the documents you have submitted.

The verification process typically takes 5-7 business days. We will notify you by email as soon as the review is complete.

If you have any questions, please feel free to contact us at pr@pharmacycouncil.org.

${signature(ctx)}
  `.trim();
}

export function buildEventPendingApprovalEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext
): EventEmailContent {
  return {
    subject: PENDING_APPROVAL_SUBJECT,
    html: textToHtml(buildPendingApprovalPlainText(firstName, lastName, ctx)),
  };
}

export async function sendEventPendingApprovalEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = buildPendingApprovalPlainText(firstName, lastName, ctx);

  try {
    await sendNipaMailEmail(email, PENDING_APPROVAL_SUBJECT, plainText);
    console.log(`[Generic] Pending approval email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending pending approval email:", error);
    throw error;
  }
}

// ============================================
// 9. VERIFICATION APPROVED EMAIL
// ============================================

export async function sendEventVerificationApprovedEmail(
  email: string,
  firstName: string,
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const loginUrl = ctx.websiteUrl + "/login";
  const commentText = comment ? `\nComment: ${comment}\n` : "";

  const plainText = `
Dear ${firstName},

Thank you for your registration for the ${ctx.eventName}. ${introLine(ctx)}

For the student registration fee, we have to check the documents to verify that they are students. Your document has been approved, so your registration has already confirmed.
${commentText}
See you soon at ${ctx.shortName}.

Login to your account: ${loginUrl}

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Approved - Registration Confirmed | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Verification approved email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending verification approved email:", error);
    throw error;
  }
}

// ============================================
// 10. VERIFICATION REJECTED EMAIL
// ============================================

export async function sendEventVerificationRejectedEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  rejectionReason?: string
): Promise<void> {
  const reasonText = rejectionReason ? `\nReason: ${rejectionReason}\n` : "";

  const plainText = `
Dear ${firstName} ${lastName},

Thank you for your registration for the ${ctx.eventName}. ${introLine(ctx)}

For the student registration fee, we have to check the documents to verify that they are students. Your document has some concerns, so could you please send us another document within 2 days? This will take 5-7 business days. After finishing checking the document, we will email you again for the registration confirmation.
${reasonText}
${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Requires Attention - Please Resubmit | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Verification rejected email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending verification rejected email:", error);
    throw error;
  }
}

// ============================================
// 11. DOCUMENT RESUBMITTED EMAIL
// ============================================

export async function sendEventDocumentResubmittedEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Dear ${firstName} ${lastName},

Thank you for resubmitting your verification document for the ${ctx.eventName}. ${introLine(ctx)}

We have received your new document and will review it within 5-7 business days. After finishing checking the document, we will email you again for the registration confirmation.

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Resubmitted - Pending Review | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Document resubmission email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending document resubmission email:", error);
    throw error;
  }
}
