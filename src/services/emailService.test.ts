import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";
import { sendNipaMailText } from "./emailService.js";
import { createPresentationMailTransport } from "../modules/presentations/email-jobs.js";

test("preserves plain-text line breaks through NipaMail's provider-compatible body field", async () => {
  const originalPost = axios.post;
  const originalClientId = process.env.NIPAMAIL_CLIENT_ID;
  const originalClientSecret = process.env.NIPAMAIL_CLIENT_SECRET;
  const originalSenderEmail = process.env.NIPAMAIL_SENDER_EMAIL;
  const calls: Array<{ url: string; body: Record<string, unknown>; timeout?: number }> = [];

  process.env.NIPAMAIL_CLIENT_ID = "test-client";
  process.env.NIPAMAIL_CLIENT_SECRET = "test-secret";
  process.env.NIPAMAIL_SENDER_EMAIL = "sender@example.com";
  (axios as unknown as { post: typeof axios.post }).post = (async (url: string, body: Record<string, unknown>, options?: { timeout?: number }) => {
    calls.push({ url, body, timeout: options?.timeout });
    if (url.endsWith("/v1/auth/tokens")) return { data: { access_token: "test-token" } } as never;
    return { data: { id: "message-id" } } as never;
  }) as typeof axios.post;

  try {
    await sendNipaMailText("recipient@example.com", "Test subject", "บรรทัดที่หนึ่ง\n\nบรรทัดที่สอง <script>alert(1)</script> &", true, { timeoutMs: 15000 });
    const transport = createPresentationMailTransport();
    await transport.send({ recipient: "recipient@example.com", subject: "Plain", html: "ignored", text: "Hello <world>\n- File" });
    await transport.send({ recipient: "recipient@example.com", subject: "Legacy", html: "<p>Old job</p>" });
    assert.equal(calls[2].timeout, 15000);
    assert.equal(Buffer.from((calls[2].body.message as Record<string, string>).html, "base64").toString(), "Hello &lt;world&gt;<br>\n- File");
    assert.equal(Buffer.from((calls[3].body.message as Record<string, string>).html, "base64").toString(), "<p>Old job</p>");
    (axios as unknown as { post: typeof axios.post }).post = (async () => { throw new axios.AxiosError("Timeout", "ECONNABORTED"); }) as typeof axios.post;
    await assert.rejects(transport.send({ recipient: "recipient@example.com", subject: "Plain", html: "ignored", text: "Body" }),
      { code: "NIPAMAIL_TIMEOUT", deliveryState: "unknown" });
  } finally {
    (axios as unknown as { post: typeof axios.post }).post = originalPost;
    if (originalClientId === undefined) delete process.env.NIPAMAIL_CLIENT_ID;
    else process.env.NIPAMAIL_CLIENT_ID = originalClientId;
    if (originalClientSecret === undefined) delete process.env.NIPAMAIL_CLIENT_SECRET;
    else process.env.NIPAMAIL_CLIENT_SECRET = originalClientSecret;
    if (originalSenderEmail === undefined) delete process.env.NIPAMAIL_SENDER_EMAIL;
    else process.env.NIPAMAIL_SENDER_EMAIL = originalSenderEmail;
  }

  assert.equal(calls.length, 4);
  const message = calls[1].body.message as Record<string, string>;
  assert.equal("text" in message, false);
  assert.equal(Buffer.from(message.html, "base64").toString("utf8"), "บรรทัดที่หนึ่ง<br>\n<br>\nบรรทัดที่สอง &lt;script&gt;alert(1)&lt;/script&gt; &amp;");
});
