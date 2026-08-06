import assert from "node:assert/strict";
import test from "node:test";
import { validateTeamDraft, type TeamDraftInput } from "./schemas.js";

type MemberInput = TeamDraftInput["members"][number];

const member = (overrides: Partial<MemberInput> = {}): MemberInput => ({
  position: 1,
  memberRole: "leader",
  title: "mr",
  firstName: "Test",
  lastName: "Leader",
  nickname: "",
  age: 20,
  university: "University",
  faculty: "Faculty of Pharmacy",
  school: null,
  schoolGrade: null,
  isPharmacyStudent: true,
  foodDrugAllergies: null,
  email: "leader@example.com",
  phoneNumber: "0812345678",
  lineId: "leader-line",
  emergencyContactName: "Parent",
  emergencyContactPhone: "0899999999",
  ...overrides,
});

test("accepts a 3-person higher-education pharmacy team", () => {
  const result = validateTeamDraft(
    {
      teamName: "Team Alpha",
      categoryId: 1,
      members: [
        member(),
        member({ position: 2, memberRole: "member", email: "two@example.com", isPharmacyStudent: false }),
        member({ position: 3, memberRole: "member", email: "three@example.com", isPharmacyStudent: false }),
      ],
    },
    { minMembers: 3, maxMembers: 5, minAge: 15, maxAge: 30, educationLevel: "higher_education", pharmacyRule: "required" },
  );
  assert.equal(result.members.length, 3);
});

test("rejects duplicate Emails after normalization", () => {
  assert.throws(() => validateTeamDraft(
    {
      teamName: "Team Alpha",
      categoryId: 1,
      members: [
        member(),
        member({ position: 2, memberRole: "member", email: " LEADER@example.com ", isPharmacyStudent: false }),
        member({ position: 3, memberRole: "member", email: "three@example.com", isPharmacyStudent: false }),
      ],
    },
    { minMembers: 3, maxMembers: 5, minAge: 15, maxAge: 30, educationLevel: "higher_education", pharmacyRule: "required" },
  ));
});

test("requires school fields and forbids pharmacy flag for upper secondary", () => {
  assert.throws(() => validateTeamDraft(
    {
      teamName: "School Team",
      categoryId: 3,
      members: [member(), member({ position: 2, memberRole: "member", email: "two@example.com" }), member({ position: 3, memberRole: "member", email: "three@example.com" })],
    },
    { minMembers: 3, maxMembers: 5, minAge: 15, maxAge: 30, educationLevel: "upper_secondary", pharmacyRule: "forbidden" },
  ));
});
