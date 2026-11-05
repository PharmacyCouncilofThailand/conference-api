export type AwardGroup = "oral" | "highlighted-poster" | "student-oral";
export type AwardLevel = "excellent" | "outstanding" | "very-good";
export type AwardRecord = {
  trackingId: string;
  group: AwardGroup;
  categoryName: string;
  awardLevel: AwardLevel;
  title: string;
  submitterName: string;
};
export type AwardFile = {
  url: string;
  mimeType: "application/pdf" | "image/png";
  version: number;
  previewUrl: string | null;
};
export type AwardItem = AwardRecord & { file: AwardFile | null };
