import assert from "node:assert/strict";
import test from "node:test";
import { registerBodySchema } from "./auth.schema.js";

const common = { firstName: "First", lastName: "Last", email: "test@example.invalid", password: "test1234", phone: "0812345678" };
const healthhack = { ...common, accountType: "healthhack", organization: "Test School", healthHackLevel: "m1" };
const booth = { ...common, accountType: "booth", boothName: "Test Booth" };

test("special accounts accept only complete personal data and supported levels", () => {
  for (const level of ["m1", "m2", "m3", "m4", "m5", "m6", "undergraduate"]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, healthHackLevel: level }).success, true);
  }
  assert.equal(registerBodySchema.safeParse(booth).success, true);
  for (const input of [healthhack, booth]) {
    for (const field of ["firstName", "lastName", "phone"]) {
      assert.equal(registerBodySchema.safeParse({ ...input, [field]: "   " }).success, false, field);
      assert.equal(registerBodySchema.safeParse({ ...input, [field]: undefined }).success, false, field);
    }
    assert.equal(registerBodySchema.safeParse({ ...input, email: "bad" }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, password: "12345" }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, firstName: "x".repeat(101) }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, lastName: "x".repeat(101) }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, phone: "x".repeat(21) }).success, false);
  }
  for (const organization of [undefined, "", "   ", "x".repeat(256)]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, organization }).success, false);
  }
  for (const healthHackLevel of [undefined, "", "m7", "postgraduate"]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, healthHackLevel }).success, false);
  }
  for (const boothName of [undefined, "", "   ", "x".repeat(256)]) {
    assert.equal(registerBodySchema.safeParse({ ...booth, boothName }).success, false);
  }
});

test("legacy registration validation stays intact", () => {
  for (const accountType of ["generalPublic", "medicalProfessional", "postgraduateStudent", "undergraduateStudent"]) {
    assert.equal(registerBodySchema.safeParse({ ...common, accountType, phone: undefined }).success, true);
  }
  assert.equal(registerBodySchema.safeParse({ ...common, accountType: "pharmacist" }).success, false);
  assert.equal(registerBodySchema.safeParse({ ...common, accountType: "pharmacist", pharmacyLicenseId: "12345" }).success, true);
});
