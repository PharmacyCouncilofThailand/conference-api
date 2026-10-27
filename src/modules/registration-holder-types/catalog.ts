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
  readonly giftCode: "mug_set1" | "large_set3" | "activity_set2" | "none";
  readonly giftLabel: string;
}

export const HOLDER_TYPES: readonly HolderTypeConfig[] = [
  { key: "council_committee", label: "กรรมการสภาเภสัชกรรม", giftCode: "mug_set1", giftLabel: "Mug SET1" },
  { key: "college_committee", label: "กรรมการราชวิทยาลัยเภสัชกรรมแห่งประเทศไทย", giftCode: "mug_set1", giftLabel: "Mug SET1" },
  { key: "vip", label: "VIP", giftCode: "mug_set1", giftLabel: "Mug SET1" },
  { key: "speaker", label: "วิทยากร", giftCode: "large_set3", giftLabel: "MAXIMUM SET3" },
  { key: "presenter", label: "ผู้นำเสนอผลงาน", giftCode: "activity_set2", giftLabel: "Activity SET2" },
  { key: "participant", label: "ผู้เข้าร่วมงาน", giftCode: "activity_set2", giftLabel: "Activity SET2" },
  { key: "exhibitor", label: "เจ้าหน้าที่บูธ (Exhibitor)", giftCode: "activity_set2", giftLabel: "Activity SET2" },
  { key: "health_hack", label: "Health Hack", giftCode: "none", giftLabel: "—" },
  { key: "media", label: "สื่อมวลชน", giftCode: "large_set3", giftLabel: "MAXIMUM SET3" },
  { key: "staff_mc", label: "เจ้าหน้าที่/MC", giftCode: "activity_set2", giftLabel: "Activity SET2" },
  { key: "reviewer", label: "กรรมการประเมินผลงาน", giftCode: "mug_set1", giftLabel: "Mug SET1" },
];

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
