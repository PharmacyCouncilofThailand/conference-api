import assert from "node:assert/strict";
import test from "node:test";
import { HOLDER_TYPES, HOLDER_TYPE_KEYS, getHolderType, holderTypeDisplay } from "./catalog.js";

const expected = [
  ["council_committee", "กรรมการสภาเภสัชกรรม", "mug_set1", "แก้ว Mug set1"],
  ["college_committee", "กรรมการราชวิทยาลัยเภสัชกรรมแห่งประเทศไทย", "mug_set1", "แก้ว Mug set1"],
  ["vip", "VIP", "mug_set1", "แก้ว Mug set1"],
  ["speaker", "วิทยากร", "large_set3", "ชุดใหญ่ไฟกระพริบ set3"],
  ["presenter", "ผู้นำเสนอผลงาน", "activity_set2", "กิจกรรม set2"],
  ["participant", "ผู้เข้าร่วมงาน", "activity_set2", "กิจกรรม set2"],
  ["exhibitor", "เจ้าหน้าที่บูธ (Exhibitor)", "activity_set2", "กิจกรรม set2"],
  ["health_hack", "Health Hack", "none", "—"],
  ["media", "สื่อมวลชน", "large_set3", "ชุดใหญ่ไฟกระพริบ set3"],
  ["staff_mc", "เจ้าหน้าที่/MC", "activity_set2", "กิจกรรม set2"],
  ["reviewer", "กรรมการประเมินผลงาน", "mug_set1", "แก้ว Mug set1"],
] as const;

test("catalog contains exactly the eleven agreed unique holder types", () => {
  assert.equal(HOLDER_TYPES.length, 11);
  assert.equal(new Set(HOLDER_TYPE_KEYS).size, 11);
  assert.deepEqual(HOLDER_TYPE_KEYS, expected.map(([key]) => key));
  assert.deepEqual(HOLDER_TYPES.map(({ key }) => key), HOLDER_TYPE_KEYS);
});

for (const [key, label, giftCode, giftLabel] of expected) {
  test(`${key} has the agreed label and gift for PRIS-2026`, () => {
    assert.deepEqual(getHolderType(key), { key, label, giftCode, giftLabel });
    assert.deepEqual(holderTypeDisplay(key, "PRIS-2026"), {
      holderTypeLabel: label,
      holderGift: giftLabel,
      holderGiftCode: giftCode,
    });
  });
}

test("unknown values never infer a holder type or gift", () => {
  for (const key of [null, undefined, "", "unknown", "PRISVIP2026", "VIP", 500, true, {}, ["vip"]]) {
    assert.equal(getHolderType(key), undefined);
    assert.deepEqual(holderTypeDisplay(key, "PRIS-2026"), {
      holderTypeLabel: null,
      holderGift: null,
        holderGiftCode: null,
    });
  }
});

test("all holder types are hidden outside the exact PRIS-2026 event scope", () => {
  for (const eventCode of [null, "", "OTHER", "PRIS-2027", "pris-2026", "PRIS-2026 "]) {
    for (const key of HOLDER_TYPE_KEYS) {
      assert.deepEqual(holderTypeDisplay(key, eventCode), {
        holderTypeLabel: null,
        holderGift: null,
        holderGiftCode: null,
      });
    }
  }
});
