import assert from "node:assert/strict";
import test from "node:test";
import { createTeamPaySolutionsClient } from "./paysolutions.client.js";

test("creates a PromptPay redirect form with the isolated merchant", () => {
  const client = createTeamPaySolutionsClient({
    merchantId: "TEAM12345",
    apiKey: "api-key",
    secretKey: "secret-key",
    baseUrl: "https://apis.example.test",
    formActionUrl: "https://payments.example.test/payment",
  });
  const result = client.createRedirectForm({
    amount: "700.00",
    referenceNo: "400000000001",
    customerEmail: "leader@example.com",
    customerName: "Team Leader",
    productDetail: "Event - Team Alpha",
  });
  assert.equal(result.actionUrl, "https://payments.example.test/payment");
  assert.deepEqual(result.fields, {
    merchantid: "TEAM12345",
    refno: "400000000001",
    customeremail: "leader@example.com",
    customername: "Team Leader",
    productdetail: "Event - Team Alpha",
    total: "700.00",
    cc: "00",
    lang: "TH",
    channel: "promptpay",
  });
});

test("sanitizes provider form display fields", () => {
  const client = createTeamPaySolutionsClient({ merchantId: "TEAM12345", apiKey: "a", secretKey: "s", baseUrl: "https://api", formActionUrl: "https://form" });
  const result = client.createRedirectForm({ amount: "850.00", referenceNo: "400000000002", customerEmail: "leader@example.com", customerName: "<Leader>", productDetail: "Event <script>" });
  assert.equal(result.fields.customername, "Leader");
  assert.equal(result.fields.productdetail, "Event script");
});
