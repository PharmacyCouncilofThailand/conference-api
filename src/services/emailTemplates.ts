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

export interface ReceiptPromotionInfo {
  discount: number;
  promoCode: string | null;
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
  regCode?: string,
  promotion?: ReceiptPromotionInfo,
): EventEmailContent {
  const currencySymbol = currency === "THB" ? "\u0E3F" : "$";
  const methodLabel = paymentChannel === "free"
    ? promotion?.promoCode ? "Free registration / Promo code" : "Free registration"
    : paymentChannel === "promptpay"
      ? "PromptPay (QR)"
      : "Credit/Debit Card";

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

  const discountLineText = promotion && promotion.discount > 0
    ? `  - Discount${promotion.promoCode ? ` (${promotion.promoCode})` : ""}: -${currencySymbol}${promotion.discount.toLocaleString()}\n`
    : "";

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
${discountLineText}${feeLineText}
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
  regCode?: string,
  promotion?: ReceiptPromotionInfo,
): Promise<void> {
  const { subject, html } = buildEventPaymentReceiptEmailContent(
    firstName, lastName, orderNumber, paidAt, paymentChannel, items,
    subtotal, fee, total, currency, receiptDownloadUrl, ctx, taxInvoice, regCode, promotion,
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

export interface AbstractAcceptedConfirmation {
  confirmUrl: string;
  deadline: Date;
}

function buildConfirmationBlock(confirmation?: AbstractAcceptedConfirmation): string {
  if (!confirmation) return "";
  const deadlineEn = confirmation.deadline.toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
  const deadlineTh = confirmation.deadline.toLocaleString("th-TH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
  return `
=== ACTION REQUIRED / กรุณายืนยันการเข้าร่วม ===

Please CONFIRM your participation by ${deadlineEn} via the link below.
If you do not confirm by the deadline, your presentation slot may be released.

กรุณายืนยันการเข้าร่วมและการนำเสนอภายในวันที่ ${deadlineTh} โดยคลิกลิงก์ด้านล่าง
หากท่านไม่ได้ยืนยันภายในกำหนด ที่นั่งการนำเสนอของท่านอาจถูกยกเลิก

Confirm here / ยืนยันที่นี่: ${confirmation.confirmUrl}
`;
}

function buildAbstractAcceptedPlainText(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  presentationType: "poster" | "oral",
  ctx: EventEmailContext,
  comment?: string,
  confirmation?: AbstractAcceptedConfirmation,
): string {
  const typeLabel = presentationType === "poster" ? "POSTER PRESENTATION" : "ORAL PRESENTATION";
  const articlePrefix = presentationType === "poster" ? "a" : "an";
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const confirmationBlock = buildConfirmationBlock(confirmation);

  return `
Dear ${firstName} ${lastName},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as ${articlePrefix} ${typeLabel} at the ${ctx.eventName}. ${introLine(ctx)}
${commentText}
All ${presentationType} presenters must be registered for the meeting in order to present${presentationType === "poster" ? " their poster" : ""}. For registration information and details go to ${ctx.websiteUrl}
${confirmationBlock}
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
  comment?: string,
  confirmation?: AbstractAcceptedConfirmation,
): EventEmailContent {
  const plainText = buildAbstractAcceptedPlainText(firstName, lastName, abstractTitle, presentationType, ctx, comment, confirmation);
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
  comment?: string,
  confirmation?: AbstractAcceptedConfirmation,
): Promise<void> {
  const plainText = buildAbstractAcceptedPlainText(firstName, lastName, abstractTitle, presentationType, ctx, comment, confirmation);
  const subject = confirmation
    ? `[Action Required] Abstract Accepted (${presentationType === "poster" ? "Poster" : "Oral"}) - ${ctx.shortName}`
    : `Congratulations! Abstract Accepted (${presentationType === "poster" ? "Poster" : "Oral"}) - ${ctx.shortName}`;

  try {
    await sendNipaMailEmail(email, subject, plainText);
    console.log(`[Generic] Abstract accepted (${presentationType}) email sent to ${email}${confirmation ? " with confirmation link" : ""}`);
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
// 6B. ABSTRACT REVISION REQUESTED EMAIL
// ============================================

function buildAbstractRevisionRequestedPlainText(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  topic: string,
  comment: string,
  ctx: EventEmailContext,
  attachmentUrls: string[] = []
): string {
  const attachmentsText =
    attachmentUrls.length > 0
      ? `\nReviewer attachment(s):\n${attachmentUrls.map((url, index) => `${index + 1}. ${url}`).join("\n")}\n`
      : "";

  return `
Dear ${firstName} ${lastName},

Thank you for submitting your abstract to ${ctx.eventName}. The review team requests a revision before the abstract can proceed.

Abstract Title: ${abstractTitle}
Section to revise: ${topic}

Revision details:
${comment}
${attachmentsText}
Please sign in to your profile, update the abstract, and resubmit it for review.

${signature(ctx)}
  `.trim();
}

export function buildEventAbstractRevisionRequestedEmailContent(
  firstName: string,
  lastName: string,
  abstractTitle: string,
  topic: string,
  comment: string,
  ctx: EventEmailContext,
  attachmentUrls: string[] = []
): EventEmailContent {
  const plainText = buildAbstractRevisionRequestedPlainText(
    firstName,
    lastName,
    abstractTitle,
    topic,
    comment,
    ctx,
    attachmentUrls,
  );

  return {
    subject: `Abstract Revision Requested - ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventAbstractRevisionRequestedEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractTitle: string,
  topic: string,
  comment: string,
  ctx: EventEmailContext,
  attachmentUrls: string[] = []
): Promise<void> {
  const plainText = buildAbstractRevisionRequestedPlainText(
    firstName,
    lastName,
    abstractTitle,
    topic,
    comment,
    ctx,
    attachmentUrls,
  );

  try {
    await sendNipaMailEmail(email, `Abstract Revision Requested - ${ctx.shortName}`, plainText);
    console.log(`[Generic] Abstract revision requested email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending abstract revision requested email:", error);
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
// 8b. EVENT REMINDER EMAIL (upcoming event reminder for confirmed registrants)
// ============================================

function buildEventReminderPlainText(
  firstName: string,
  lastName: string,
  regCode: string,
  ctx: EventEmailContext
): string {
  return `
เรียน คุณ${firstName} ${lastName}

ใกล้ถึงวันงาน ${ctx.eventName} แล้ว ทางทีมงานขอส่งอีเมลฉบับนี้เพื่อแจ้งเตือนล่วงหน้าครับ

รายละเอียดงาน
- วันที่: ${ctx.dates}
- สถานที่: ${ctx.venue}
- รหัสลงทะเบียนของท่าน: ${regCode}

สิ่งที่ควรเตรียมในวันงาน
1. Ticket พร้อมรหัสลงทะเบียน (หรือ QR code) เพื่อใช้เช็คอินหน้างาน
2. กรุณามาถึงสถานที่จัดงานล่วงหน้าอย่างน้อย 30 นาทีก่อนเริ่มเซสชันแรก
3. ตรวจสอบกำหนดการและข่าวสารล่าสุดได้ที่ ${ctx.websiteUrl}

หากท่านใดต้องการชวนเพื่อนหรือเพื่อนร่วมงานเข้าร่วม ยังสามารถลงทะเบียนล่วงหน้าผ่านเว็บไซต์ ${ctx.websiteUrl} ได้จนถึงวันงาน หรือจะลงทะเบียนหน้างาน (Walk-in) ในวันจัดงานก็ได้เช่นกัน

หากมีข้อสงสัยเพิ่มเติม สามารถติดต่อได้ที่ pr@pharmacycouncil.org

แล้วพบกันในงานนะครับ

ขอแสดงความนับถือ
สภาเภสัชกรรม (The Pharmacy Council of Thailand)
  `.trim();
}

export function buildEventReminderEmailContent(
  firstName: string,
  lastName: string,
  regCode: string,
  ctx: EventEmailContext
): EventEmailContent {
  return {
    subject: `แจ้งเตือน: ใกล้ถึงวันงาน ${ctx.shortName} แล้ว (${ctx.dates})`,
    html: textToHtml(buildEventReminderPlainText(firstName, lastName, regCode, ctx)),
  };
}

export async function sendEventReminderEmail(
  email: string,
  firstName: string,
  lastName: string,
  regCode: string,
  ctx: EventEmailContext
): Promise<void> {
  const { subject } = buildEventReminderEmailContent(firstName, lastName, regCode, ctx);
  const plainText = buildEventReminderPlainText(firstName, lastName, regCode, ctx);

  try {
    await sendNipaMailEmail(email, subject, plainText);
    console.log(`[Generic] Event reminder email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending event reminder email:", error);
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

// ============================================
// 12. EVENT POSTGRADUATE STUDENT ELIGIBILITY EMAILS
// ============================================

export function buildEventStudentEligibilitySubmittedEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  isResubmission = false
): EventEmailContent {
  const actionText = isResubmission ? "resubmitting" : "submitting";
  const documentText = isResubmission ? "updated document" : "document";
  const plainText = `
Dear ${firstName} ${lastName},

Thank you for ${actionText} your ${documentText} for postgraduate student-rate eligibility for ${ctx.eventName}. ${introLine(ctx)}

We have received your document and will review it within 5-7 business days. We will notify you by email as soon as the review is complete.

If you have any questions, please contact us at pr@pharmacycouncil.org.

${signature(ctx)}
  `.trim();

  return {
    subject: `Postgraduate Student-Rate Request Received | ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventStudentEligibilitySubmittedEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  isResubmission = false
): Promise<void> {
  const { subject, html } = buildEventStudentEligibilitySubmittedEmailContent(
    firstName,
    lastName,
    ctx,
    isResubmission,
  );

  try {
    await sendNipaMailHtml(email, subject, html);
    console.log(`[Generic] Student eligibility pending email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending student eligibility pending email:", error);
    throw error;
  }
}

export function buildEventStudentEligibilityApprovedEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  comment?: string
): EventEmailContent {
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const loginUrl = ctx.websiteUrl + "/login";
  const plainText = `
Dear ${firstName} ${lastName},

Your postgraduate student-rate eligibility for ${ctx.eventName} has been approved.

You can now register for this event using the postgraduate student-rate ticket while signed in with this pharmacist account.
${commentText}
Login to your account: ${loginUrl}

${signature(ctx)}
  `.trim();

  return {
    subject: `Postgraduate Student-Rate Approved | ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventStudentEligibilityApprovedEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const { subject, html } = buildEventStudentEligibilityApprovedEmailContent(
    firstName,
    lastName,
    ctx,
    comment,
  );

  try {
    await sendNipaMailHtml(email, subject, html);
    console.log(`[Generic] Student eligibility approved email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending student eligibility approved email:", error);
    throw error;
  }
}

export function buildEventStudentEligibilityRejectedEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  rejectionReason: string,
  comment?: string
): EventEmailContent {
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const loginUrl = ctx.websiteUrl + "/login";
  const plainText = `
Dear ${firstName} ${lastName},

Thank you for submitting your document for postgraduate student-rate eligibility for ${ctx.eventName}.

Your request requires attention before it can be approved.

Reason: ${rejectionReason}
${commentText}
Please sign in to your profile and submit an updated document. The next review may take 5-7 business days after resubmission.

Login to your account: ${loginUrl}

${signature(ctx)}
  `.trim();

  return {
    subject: `Postgraduate Student-Rate Request Requires Attention | ${ctx.shortName}`,
    html: textToHtml(plainText),
  };
}

export async function sendEventStudentEligibilityRejectedEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  rejectionReason: string,
  comment?: string
): Promise<void> {
  const { subject, html } = buildEventStudentEligibilityRejectedEmailContent(
    firstName,
    lastName,
    ctx,
    rejectionReason,
    comment,
  );

  try {
    await sendNipaMailHtml(email, subject, html);
    console.log(`[Generic] Student eligibility rejected email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending student eligibility rejected email:", error);
    throw error;
  }
}
