import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { TeamRegistrationError } from "./errors.js";
import {
  createTeamPaySolutionsClient,
  parseTeamPaySolutionsInquiry,
  type PaySolutionsClientConfig,
  type TeamPaySolutionsTransport,
} from "./paysolutions.client.js";

const baseConfig: PaySolutionsClientConfig = {
  merchantId: "TEAM12345",
  apiKey: "api-key",
  secretKey: "secret-key",
  baseUrl: "https://apis.example.test",
  formActionUrl: "https://payments.example.test/payment",
  nodeEnv: "test",
};

test("creates a PromptPay redirect form with the isolated merchant", () => {
  const client = createTeamPaySolutionsClient(baseConfig);
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
  const client = createTeamPaySolutionsClient({ ...baseConfig, apiKey: "a", secretKey: "s" });
  const result = client.createRedirectForm({ amount: "850.00", referenceNo: "400000000002", customerEmail: "leader@example.com", customerName: "<Leader>", productDetail: "Event <script>" });
  assert.equal(result.fields.customername, "Leader");
  assert.equal(result.fields.productdetail, "Event script");
});

test("inquiry uses QWERTY defaults and bounded zero-redirect transport", async () => {
  let request: { url: string; data: unknown; config: Parameters<TeamPaySolutionsTransport["post"]>[2] } | undefined;
  const transport: TeamPaySolutionsTransport = {
    async post<T>(url: string, data: unknown, config: Parameters<TeamPaySolutionsTransport["post"]>[2]) {
      request = { url, data, config };
      return { data: [{
        ReferenceNo: "400000000001",
        MerchantID: "12345",
        Status: "CP",
        StatusName: "Complete",
        Total: "700.00",
        CurrencyCode: "00",
      }] as T };
    },
  };
  const result = await createTeamPaySolutionsClient(baseConfig, transport).inquiry("400000000001");
  assert.equal(result?.referenceNo, "400000000001");
  assert.equal(request?.url, "https://apis.example.test/order/orderdetailpost");
  assert.deepEqual(request?.data, {
    merchantID: "12345",
    orderNo: "X",
    refno: "400000000001",
    productDetail: "QWERTY",
  });
  assert.equal(request?.config.timeout, 20_000);
  assert.equal(request?.config.maxRedirects, 0);
  assert.equal(request?.config.maxContentLength, 64 * 1024);
  assert.equal(request?.config.maxBodyLength, 64 * 1024);
});

test("inquiry accepts the sanitized explicit product-detail override", async () => {
  let body: unknown;
  const transport: TeamPaySolutionsTransport = {
    async post<T>(_url: string, data: unknown) {
      body = data;
      return { data: [] as T };
    },
  };
  await createTeamPaySolutionsClient({
    ...baseConfig,
    inquiryProductDetail: " Team <Alpha> ",
  }, transport).inquiry("400000000001");
  assert.equal((body as { productDetail: string }).productDetail, "Team Alpha");
});

test("parser preserves absent, valid, and present-invalid paidAt states", () => {
  const baseRow = {
    ReferenceNo: "400000000001",
    MerchantID: "12345",
    Status: "CP",
    Total: "700.00",
    CurrencyCode: "00",
  };
  assert.deepEqual(parseTeamPaySolutionsInquiry([baseRow])?.paidAtState, "absent");
  const valid = parseTeamPaySolutionsInquiry([{ ...baseRow, PaidDate: "2026-08-10T10:00:00.000Z" }]);
  assert.equal(valid?.paidAtState, "valid");
  assert.equal(valid?.paidAt?.toISOString(), "2026-08-10T10:00:00.000Z");
  for (const malformed of ["", "not-a-date", null, {}]) {
    const result = parseTeamPaySolutionsInquiry([{ ...baseRow, PaidDate: malformed }]);
    assert.equal(result?.paidAtState, "invalid");
    assert.equal(result?.paidAt, null);
  }
});

test("parser validates only the first inquiry row", () => {
  assert.equal(parseTeamPaySolutionsInquiry([null, { ReferenceNo: "400000000001" }]), null);
  assert.equal(parseTeamPaySolutionsInquiry({ ReferenceNo: "400000000001" }), null);
});

test("transport failures expose a controlled error without request secrets", async () => {
  const markers = ["marker-api-key", "marker-secret-key", "marker-body"];
  const transport: TeamPaySolutionsTransport = {
    async post() {
      const error = new Error(markers.join("/")) as Error & { config?: unknown };
      error.config = {
        headers: { apikey: markers[0], merchantSecretKey: markers[1] },
        data: markers[2],
      };
      throw error;
    },
  };

  await assert.rejects(
    createTeamPaySolutionsClient({
      ...baseConfig,
      apiKey: markers[0],
      secretKey: markers[1],
    }, transport).inquiry("400000000001"),
    (error: unknown) => {
      assert.ok(error instanceof TeamRegistrationError);
      assert.equal(error.statusCode, 503);
      assert.equal(error.code, "PAYMENT_PROVIDER_UNAVAILABLE");
      const exposed = `${error.message} ${JSON.stringify(error)}`;
      for (const marker of markers) assert.equal(exposed.includes(marker), false);
      return true;
    },
  );
});

test("provider URLs require HTTPS except loopback HTTP outside production", () => {
  assert.doesNotThrow(() => createTeamPaySolutionsClient({
    ...baseConfig,
    baseUrl: "http://127.0.0.1:8080",
    formActionUrl: "http://localhost:8081/payment",
    nodeEnv: "test",
  }));
  for (const config of [
    { ...baseConfig, baseUrl: "http://provider.example.test" },
    { ...baseConfig, baseUrl: "http://127.0.0.1:8080", nodeEnv: "production" },
    { ...baseConfig, formActionUrl: "https://user:password@provider.example.test/payment" },
  ]) {
    assert.throws(() => createTeamPaySolutionsClient(config), (error: unknown) => {
      assert.ok(error instanceof TeamRegistrationError);
      assert.equal(error.code, "TEAM_PAYMENT_CONFIG_ERROR");
      return true;
    });
  }
});

test("real transport rejects inquiry responses larger than 64 KiB", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([{ ReferenceNo: "400000000001", padding: "x".repeat(70 * 1024) }]));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    createTeamPaySolutionsClient({
      ...baseConfig,
      baseUrl: `http://127.0.0.1:${address.port}`,
      nodeEnv: "test",
    }).inquiry("400000000001"),
    (error: unknown) => error instanceof TeamRegistrationError
      && error.code === "PAYMENT_PROVIDER_UNAVAILABLE",
  );
});

test("real transport does not follow inquiry redirects", async (t) => {
  let followed = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") {
      followed = true;
      response.end("[]");
      return;
    }
    response.writeHead(302, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  await assert.rejects(
    createTeamPaySolutionsClient({
      ...baseConfig,
      baseUrl: `http://127.0.0.1:${address.port}`,
      nodeEnv: "test",
    }).inquiry("400000000001"),
    (error: unknown) => error instanceof TeamRegistrationError
      && error.code === "PAYMENT_PROVIDER_UNAVAILABLE",
  );
  assert.equal(followed, false);
});
