import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import ts from "typescript";
import { ApiError } from "./ApiError.js";

test("global rate limit returns 429 through the application error handler", async () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const rateConfig = source.slice(source.indexOf("fastify.register(rateLimit,"), source.indexOf("// Multipart & JWT"));
  const errorHandler = source.slice(source.indexOf("fastify.setErrorHandler("), source.indexOf("// Route Imports"));
  const app = Fastify();
  try {
    runInNewContext(ts.transpile(rateConfig + errorHandler), {
      ApiError,
      rateLimit,
      fastify: {
        register: (plugin: typeof rateLimit, options: object) => app.register(plugin, { ...options, max: 1 }),
        setErrorHandler: app.setErrorHandler.bind(app),
        log: app.log,
      },
    });
    await app;
    app.get("/", async () => ({ ok: true }));
    assert.equal((await app.inject("/")).statusCode, 200);
    const limited = await app.inject("/");
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.json().code, "RATE_LIMIT_EXCEEDED");
    assert.equal(limited.json().error, "Too many requests. Please try again later.");
    assert.ok(limited.headers["retry-after"]);
    assert.ok(limited.json().requestId);
  } finally {
    await app.close();
  }
});
