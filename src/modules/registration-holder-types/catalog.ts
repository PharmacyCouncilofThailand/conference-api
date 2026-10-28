export const HOLDER_TYPE_KEYS = [
  "council_committee",
  "college_committee",
  "vip",
  "speaker",
  "presenter",
  "participant",
  "exhibitor",
  "health_hack",
  "media",
  "staff_mc",
  "reviewer",
] as const;

export type HolderTypeKey = (typeof HOLDER_TYPE_KEYS)[number];

export interface HolderTypeConfig {
  readonly key: HolderTypeKey;
  readonly label: string;
  // Only VIPs and key people of the event receive a gift (decided 27 Oct 2026).
  readonly giftCode: "gift" | "none";
  readonly giftLabel: string;
}

export const HOLDER_TYPES: readonly HolderTypeConfig[] = [
  { key: "council_committee", label: "กรรมการสภาเภสัชกรรม", giftCode: "gift", giftLabel: "ให้" },
  { key: "college_committee", label: "กรรมการราชวิทยาลัยเภสัชกรรมแห่งประเทศไทย", giftCode: "gift", giftLabel: "ให้" },
  { key: "vip", label: "VIP", giftCode: "gift", giftLabel: "ให้" },
  { key: "speaker", label: "วิทยากร", giftCode: "none", giftLabel: "" },
  { key: "presenter", label: "ผู้นำเสนอผลงาน", giftCode: "none", giftLabel: "" },
  { key: "participant", label: "ผู้เข้าร่วมงาน", giftCode: "none", giftLabel: "" },
  { key: "exhibitor", label: "เจ้าหน้าที่บูธ (Exhibitor)", giftCode: "none", giftLabel: "" },
  { key: "health_hack", label: "Health Hack", giftCode: "none", giftLabel: "" },
  { key: "media", label: "สื่อมวลชน", giftCode: "none", giftLabel: "" },
  { key: "staff_mc", label: "เจ้าหน้าที่/MC", giftCode: "none", giftLabel: "" },
  { key: "reviewer", label: "กรรมการประเมินผลงาน", giftCode: "gift", giftLabel: "ให้" },
];

// Holder types that receive the meal coupon (2 per person) in addition to
// Booth members within their Booth quota. VIP was added and then removed on
// 27 Oct 2026, so only Booth members qualify for now.
export const MEAL_COUPON_HOLDER_TYPES: readonly HolderTypeKey[] = [];

export function hasMealCoupon(
  holderType: unknown,
  eventCode: string | null,
  boothEligible: boolean | null | undefined,
): boolean {
  if (boothEligible === true) return true;
  return (
    eventCode === "PRIS-2026" &&
    typeof holderType === "string" &&
    (MEAL_COUPON_HOLDER_TYPES as readonly string[]).includes(holderType)
  );
}

export type MealCouponStatus = "eligible" | "over_quota" | null;

/** Coupon for display: eligible, Booth member past the Booth quota, or none. */
export function mealCouponStatus(
  holderType: unknown,
  eventCode: string | null,
  boothEligible: boolean | null | undefined,
): MealCouponStatus {
  if (hasMealCoupon(holderType, eventCode, boothEligible)) return "eligible";
  return boothEligible === false ? "over_quota" : null;
}

export function getHolderType(key: unknown): HolderTypeConfig | undefined {
  return typeof key === "string"
    ? HOLDER_TYPES.find((holderType) => holderType.key === key)
    : undefined;
}

export function holderTypeDisplay(
  key: unknown,
  eventCode: string | null,
): { holderTypeLabel: string | null; holderGift: string | null; holderGiftCode: HolderTypeConfig['giftCode'] | null } {
  const holderType = eventCode === "PRIS-2026" ? getHolderType(key) : undefined;
  return {
    holderTypeLabel: holderType?.label ?? null,
    holderGift: holderType?.giftLabel ?? null,
    holderGiftCode: holderType?.giftCode ?? null,
  };
}
