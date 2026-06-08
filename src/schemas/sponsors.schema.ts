import { z } from "zod";

export const sponsorPackageTypeValues = ["booth", "symposium", "bundle"] as const;
export const sponsorMediaTypeValues = [
  "past_sponsor_logo",
  "previous_year_impression",
  "brochure",
  "other",
] as const;
export const sponsorApplicationStatusValues = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "cancelled",
] as const;
export const sponsorPaymentStatusValues = [
  "pending_review",
  "verified",
  "rejected",
] as const;

const emptyToUndefined = (value: unknown) => {
  if (value === "" || value === null || value === undefined) return undefined;
  return value;
};

const optionalString = (max: number) =>
  z.preprocess(emptyToUndefined, z.string().max(max).optional());

const optionalUrl = z.preprocess(
  emptyToUndefined,
  z.string().url().max(2000).optional(),
);

const money = z.preprocess(
  (value) => {
    if (value === "" || value === null || value === undefined) return 0;
    return Number(value);
  },
  z.number().min(0),
);

export const sponsorProfileSchema = z.object({
  aboutTitle: optionalString(255),
  aboutDescription: z.preprocess(emptyToUndefined, z.string().optional()),
  organizerLogoUrl: optionalUrl,
  brochureUrl: optionalUrl,
  registrationOpenAt: z.preprocess(emptyToUndefined, z.string().datetime().optional()),
  registrationCloseAt: z.preprocess(emptyToUndefined, z.string().datetime().optional()),
  isPublished: z.boolean().optional(),
});

export const sponsorStatSchema = z.object({
  valueText: z.string().min(1).max(50),
  label: z.string().min(1).max(255),
  description: z.preprocess(emptyToUndefined, z.string().optional()),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateSponsorStatSchema = sponsorStatSchema.partial();

export const sponsorPackageFeatureInputSchema = z.object({
  featureText: z.string().min(1).max(500),
  sortOrder: z.coerce.number().int().min(0).default(0),
});

const sponsorPackageComponentInputSchema = z.object({
  componentPackageId: z.coerce.number().int().positive(),
  componentRole: optionalString(50),
});

export const sponsorPackageSchema = z.object({
  packageType: z.enum(sponsorPackageTypeValues),
  code: z.string().min(1).max(50),
  optionLabel: optionalString(100),
  name: z.string().min(1).max(255),
  description: z.preprocess(emptyToUndefined, z.string().optional()),
  price: money.default(0),
  currency: z.string().length(3).default("THB"),
  quota: z.coerce.number().int().min(0).default(0),
  badgeText: optionalString(100),
  themeKey: optionalString(50),
  isRecommended: z.boolean().optional().default(false),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
  features: z.array(sponsorPackageFeatureInputSchema).optional().default([]),
  components: z.array(sponsorPackageComponentInputSchema).optional().default([]),
});

export const updateSponsorPackageSchema = sponsorPackageSchema
  .omit({ features: true, components: true })
  .partial()
  .extend({
    features: z.array(sponsorPackageFeatureInputSchema).optional(),
    components: z.array(sponsorPackageComponentInputSchema).optional(),
  });

export const sponsorPackageComponentsSchema = z.object({
  components: z.array(sponsorPackageComponentInputSchema).default([]),
});

export const sponsorPackageFeaturesSchema = z.object({
  features: z.array(sponsorPackageFeatureInputSchema).default([]),
});

export const sponsorBenefitSchema = z.object({
  title: z.string().min(1).max(255),
  description: z.preprocess(emptyToUndefined, z.string().optional()),
  iconKey: optionalString(50),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateSponsorBenefitSchema = sponsorBenefitSchema.partial();

export const sponsorMediaAssetSchema = z.object({
  mediaType: z.enum(sponsorMediaTypeValues),
  title: optionalString(255),
  caption: optionalString(500),
  fileUrl: z.string().min(1).max(2000),
  fileName: optionalString(255),
  mimeType: optionalString(100),
  fileSize: z.coerce.number().int().min(0).optional(),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateSponsorMediaAssetSchema = sponsorMediaAssetSchema.partial();

export const sponsorMediaQuerySchema = z.object({
  mediaType: z.enum(sponsorMediaTypeValues).optional(),
  activeOnly: z.coerce.boolean().optional(),
});

export const sponsorTimelineItemSchema = z.object({
  periodLabel: z.string().min(1).max(100),
  title: z.string().min(1).max(255),
  description: z.preprocess(emptyToUndefined, z.string().optional()),
  startDate: z.preprocess(emptyToUndefined, z.string().datetime().optional()),
  endDate: z.preprocess(emptyToUndefined, z.string().datetime().optional()),
  isHighlight: z.boolean().optional().default(false),
  sortOrder: z.coerce.number().int().min(0).default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateSponsorTimelineItemSchema = sponsorTimelineItemSchema.partial();

export const sponsorApplicationItemInputSchema = z.object({
  packageId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().int().positive().default(1),
});

export const sponsorApplicationSchema = z.object({
  companyName: z.string().min(1).max(255),
  contactFullName: z.string().min(1).max(255),
  businessEmail: z.string().email().max(255),
  phone: z.string().min(1).max(50),
  billingName: z.string().min(1).max(255),
  taxId: z.string().regex(/^\d{13}$/, "taxId must be 13 digits"),
  billingAddress: z.string().min(1),
  paymentSlipUrl: optionalUrl,
  paymentSlipFileName: optionalString(255),
  logoUrl: optionalUrl,
  logoFileName: optionalString(255),
  items: z.array(sponsorApplicationItemInputSchema).min(1),
});

export const sponsorApplicationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  eventId: z.coerce.number().int().positive().optional(),
  status: z.enum(sponsorApplicationStatusValues).optional(),
  paymentStatus: z.enum(sponsorPaymentStatusValues).optional(),
  search: z.string().optional(),
});

export const updateSponsorApplicationSchema = z.object({
  companyName: optionalString(255),
  contactFullName: optionalString(255),
  businessEmail: z.preprocess(emptyToUndefined, z.string().email().max(255).optional()),
  phone: optionalString(50),
  billingName: optionalString(255),
  taxId: z.preprocess(
    emptyToUndefined,
    z.string().regex(/^\d{13}$/, "taxId must be 13 digits").optional(),
  ),
  billingAddress: z.preprocess(emptyToUndefined, z.string().optional()),
  paymentSlipUrl: optionalUrl,
  paymentSlipFileName: optionalString(255),
  logoUrl: optionalUrl,
  logoFileName: optionalString(255),
  internalNote: z.preprocess(emptyToUndefined, z.string().optional()),
});

export const sponsorApplicationStatusUpdateSchema = z.object({
  status: z.enum(sponsorApplicationStatusValues),
  rejectionReason: z.preprocess(emptyToUndefined, z.string().optional()),
  internalNote: z.preprocess(emptyToUndefined, z.string().optional()),
});

export const sponsorPaymentStatusUpdateSchema = z.object({
  paymentStatus: z.enum(sponsorPaymentStatusValues),
  internalNote: z.preprocess(emptyToUndefined, z.string().optional()),
});

export type SponsorApplicationInput = z.infer<typeof sponsorApplicationSchema>;
