import assert from "node:assert/strict";
import test from "node:test";
import { createTicketTypeSchema, updateTicketTypeSchema } from "./events.schema.js";

test("ticket create/update permits new attendee roles but never staff roles", () => {
  for (const role of ["healthhack", "booth"]) {
    const allowedRoles = JSON.stringify([role]);
    assert.equal(createTicketTypeSchema.safeParse({ category: "primary", name: role, price: 1000, quota: 10, allowedRoles }).success, true);
    assert.equal(updateTicketTypeSchema.safeParse({ allowedRoles }).success, true);
  }
  for (const role of ["admin", "organizer", "made_up"]) {
    assert.equal(updateTicketTypeSchema.safeParse({ allowedRoles: JSON.stringify([role]) }).success, false);
  }
});
