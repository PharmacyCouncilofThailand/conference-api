import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { ApiError } from "../../errors/ApiError.js";
import type { PresentationDatabase } from "./access.js";
import { awardResults } from "./data/awardResults.js";
import { approvedRound2Abstracts as roster } from "./data/approvedRound2Abstracts.js";
import { sourceKey } from "./policy.js";
import {
  projectAwardResults,
  presentationAwardRoutes,
  type AwardFileRow,
} from "./awards.js";

const file: AwardFileRow = {
  sourceKey: sourceKey(roster.find((r) => r.trackingId === "PRIS-2026-O099")!),
  trackingId: "PRIS-2026-O099",
  matchState: "ready",
  url: "https://test.r2.dev/events/2/presentations/389/12345678-abcd.pdf",
  mimeType: "application/pdf",
  version: 2,
  fileStatus: "available",
};

test("official winners retain identities, categories and joint awards", () => {
  assert.equal(awardResults.length, 57);
  assert.equal(new Set(awardResults.map((r) => r.trackingId)).size, 57);
  assert.deepEqual(
    ["oral", "highlighted-poster", "student-oral"].map(
      (g) => awardResults.filter((r) => r.group === g).length,
    ),
    [23, 25, 9],
  );
  assert.deepEqual(
    ["excellent", "outstanding", "very-good"].map(
      (a) => awardResults.filter((r) => r.awardLevel === a).length,
    ),
    [18, 18, 21],
  );
  assert.equal(
    new Set(
      awardResults
        .filter((r) => r.group === "student-oral")
        .map((r) => r.categoryName),
    ).size,
    3,
  );
  assert.ok(
    awardResults.every((a) =>
      roster.some((r) => r.trackingId === a.trackingId),
    ),
  );
  assert.equal(
    awardResults.filter((r) => r.trackingId === "PRIS-2026-O099").length,
    1,
  );
  assert.ok(!awardResults.some((r) => r.trackingId === "PRIS-2026-P099"));
  assert.ok(
    awardResults.every((r) => r.title && r.submitterName && r.categoryName),
  );
});
test("current files require exact unique roster/source identity and available state", () => {
  const find = (files: AwardFileRow[], eligible = roster) =>
    projectAwardResults(eligible, files).find(
      (r) => r.trackingId === file.trackingId,
    )!;
  assert.equal(find([file]).file?.version, 2);
  assert.equal(find([{ ...file, version: 3 }]).file?.version, 3);
  for (const fileStatus of ["deletion_pending", "deleted"])
    assert.equal(find([{ ...file, fileStatus }]).file, null);
  assert.equal(find([{ ...file, sourceKey: "1:78" }]).file, null);
  assert.equal(find([{ ...file, trackingId: "PRIS-2026-P099" }]).file, null);
  assert.equal(find([{ ...file, matchState: "conflict" }]).file, null);
  assert.equal(find([file, file]).file, null);
  assert.equal(find([file], []).file, null);
  assert.equal(projectAwardResults([], []).length, 57);
  assert.equal(
    find([{ ...file, url: "https://attacker.example/private" }]).file,
    null,
  );
  assert.equal(find([{ ...file, url: file.url + "?token=secret" }]).file, null);
  assert.deepEqual(Object.keys(find([file])).sort(), [
    "awardLevel",
    "categoryName",
    "file",
    "group",
    "submitterName",
    "title",
    "trackingId",
  ]);
  assert.deepEqual(Object.keys(find([file]).file!).sort(), [
    "mimeType",
    "previewUrl",
    "url",
    "version",
  ]);
});
test("public Drive thumbnail derives only from a public file URL", () => {
  const item = projectAwardResults(roster, [
    { ...file, url: "https://drive.google.com/file/d/public_id/view" },
  ]).find((r) => r.trackingId === file.trackingId)!;
  assert.equal(
    item.file?.previewUrl,
    "https://drive.google.com/thumbnail?id=public_id&sz=w900",
  );
});
test("awards route is public, no-store, event scoped and recoverable on database failure", async (t) => {
  let unavailable = false;
  const database = {
    execute: async () => {
      if (unavailable) throw new Error("private database detail");
      return [file];
    },
  } as unknown as PresentationDatabase;
  const app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send(error.toJSON());
    throw error;
  });
  await app.register(presentationAwardRoutes, {
    prefix: "/api/events",
    database,
  });
  const response = await app.inject("/api/events/PRIS-2026/awards");
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.json().data.items.length, 57);
  assert.equal((await app.inject("/api/events/OTHER/awards")).statusCode, 404);
  assert.equal(
    (await app.inject("/api/events/PRIS-2026/awards?x=1")).statusCode,
    400,
  );
  unavailable = true;
  const failed = await app.inject("/api/events/PRIS-2026/awards");
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().code, "AWARDS_UNAVAILABLE");
  assert.ok(!failed.body.includes("private database detail"));
});
