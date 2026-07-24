import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  decimal,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// --------------------------------------------------------------------------
// 1. ENUMS
// --------------------------------------------------------------------------
export const userRoleEnum = pgEnum("user_role", [
  "pharmacist",
  "medical_professional",
  "general",
  "student",
]);
export const studentLevelEnum = pgEnum("student_level", [
  "postgraduate",
  "undergraduate",
]);
export const accountStatusEnum = pgEnum("account_status", [
  "pending_approval",
  "active",
  "rejected",
]);
export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "published",
  "cancelled",
  "completed",
]);
export const eventTypeEnum = pgEnum("event_type", [
  "single_room",
  "multi_session",
]);
export const ticketCategoryEnum = pgEnum("ticket_category", [
  "primary",
  "addon",
]);
export const ticketPriorityEnum = pgEnum("ticket_priority", [
  "early_bird",
  "regular",
  "late",
  "onsite",
]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "cancelled",
]);
export const orderItemTypeEnum = pgEnum("order_item_type", ["ticket", "addon"]);
export const registrationStatusEnum = pgEnum("registration_status", [
  "confirmed",
  "cancelled",
]);
// Abstract category is now a varchar - categories managed per-event in abstract_categories table
// See abstractCategories table below for per-event category management

export const presentationTypeEnum = pgEnum("presentation_type", [
  "oral",
  "poster",
]);
export const abstractStatusEnum = pgEnum("abstract_status", [
  "pending",
  "accepted",
  "rejected",
  "revision",
]);
export const speakerTypeEnum = pgEnum("speaker_type", [
  "keynote",
  "panelist",
  "moderator",
  "guest",
]);
export const staffRoleEnum = pgEnum("staff_role", [
  "admin",
  "organizer",
  "reviewer",
  "staff",
  "verifier",
]);
export const sessionTypeEnum = pgEnum("session_type", [
  "workshop",
  "gala_dinner",
  "lecture",
  "ceremony",
  "break",
  "other",
]);
export const sponsorPackageTypeEnum = pgEnum("sponsor_package_type", [
  "booth",
  "symposium",
  "bundle",
]);
export const sponsorMediaTypeEnum = pgEnum("sponsor_media_type", [
  "past_sponsor_logo",
  "previous_year_impression",
  "brochure",
  "other",
]);
export const sponsorApplicationStatusEnum = pgEnum("sponsor_application_status", [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "cancelled",
]);
export const sponsorPaymentStatusEnum = pgEnum("sponsor_payment_status", [
  "pending_review",
  "verified",
  "rejected",
]);

// --------------------------------------------------------------------------
// 2. USER MANAGEMENT
// --------------------------------------------------------------------------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 20 }),
  country: varchar("country", { length: 100 }),
  institution: varchar("institution", { length: 255 }),
  university: varchar("university", { length: 255 }),
  thaiIdCard: varchar("thai_id_card", { length: 13 }).unique(),
  passportId: varchar("passport_id", { length: 20 }).unique(),
  pharmacyLicenseId: varchar("pharmacy_license_id", { length: 20 }).unique(),
  verificationDocUrl: varchar("verification_doc_url", { length: 500 }),
  status: accountStatusEnum("status").notNull().default("pending_approval"),
  rejectionReason: text("rejection_reason"),
  resubmissionCount: integer("resubmission_count").notNull().default(0),
  studentLevel: studentLevelEnum("student_level"),
  registeredFromEvent: varchar("registered_from_event", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 2A. PASSWORD RESET TOKENS
// --------------------------------------------------------------------------
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 2A2. SSO TOKENS (One-Time Token for cross-app SSO)
// --------------------------------------------------------------------------
export const ssoTokens = pgTable("sso_tokens", {
  id: serial("id").primaryKey(),
  token: varchar("token", { length: 255 }).notNull().unique(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  eventId: integer("event_id").references(() => events.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").default(false).notNull(),
  sourceApp: varchar("source_app", { length: 50 }).notNull(),
  targetApp: varchar("target_app", { length: 50 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// --------------------------------------------------------------------------
// 2B. BACKOFFICE STAFF
// --------------------------------------------------------------------------
export const backofficeUsers = pgTable("backoffice_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: staffRoleEnum("role").notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  conferenceCode: varchar("conference_code", { length: 100 }),
  // Categories that this reviewer is responsible for (only applicable for role = 'reviewer')
  assignedCategories: jsonb("assigned_categories")
    .$type<string[]>()
    .default([]),
  assignedPresentationTypes: jsonb("assigned_presentation_types")
    .$type<string[]>()
    .default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 3. EVENTS & SESSIONS
// --------------------------------------------------------------------------
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  eventCode: varchar("event_code", { length: 50 }).notNull().unique(),
  eventName: varchar("event_name", { length: 255 }).notNull(),
  description: text("description"),
  eventType: eventTypeEnum("event_type").notNull(),
  location: varchar("location", { length: 255 }),
  category: varchar("category", { length: 100 }),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  maxCapacity: integer("max_capacity").notNull().default(100),
  conferenceCode: varchar("conference_code", { length: 100 }),
  cpeCredits: decimal("cpe_credits", { precision: 5, scale: 2 }).default("0"),
  status: eventStatusEnum("status").notNull().default("draft"),
  imageUrl: varchar("image_url", { length: 500 }),
  coverImage: varchar("cover_image", { length: 500 }),
  videoUrl: varchar("video_url", { length: 2000 }),
  mapUrl: varchar("map_url", { length: 2000 }),
  websiteUrl: varchar("website_url", { length: 500 }),
  shortName: varchar("short_name", { length: 100 }),
  abstractStartDate: timestamp("abstract_start_date"),
  abstractEndDate: timestamp("abstract_end_date"),
  documents: jsonb("documents")
    .$type<{ name: string; url: string }[]>()
    .default([]),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  sessionCode: varchar("session_code", { length: 50 }).notNull(),
  sessionName: varchar("session_name", { length: 255 }).notNull(),
  sessionType: sessionTypeEnum("session_type").default("other"),
  isMainSession: boolean("is_main_session").notNull().default(false),
  requiresOptIn: boolean("requires_opt_in").notNull().default(false),
  description: text("description"),
  room: varchar("room", { length: 100 }),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  maxCapacity: integer("max_capacity").default(100),
  agenda: jsonb("agenda").$type<{ time: string; topic: string }[]>(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffEventAssignments = pgTable("staff_event_assignments", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id")
    .notNull()
    .references(() => backofficeUsers.id, { onDelete: "cascade" }),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
});

export const eventStudentEligibilityRequests = pgTable("event_student_eligibility_requests", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  studentLevel: studentLevelEnum("student_level").notNull().default("postgraduate"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  documentFileName: varchar("document_file_name", { length: 255 }).notNull(),
  documentFileUrl: varchar("document_file_url", { length: 500 }).notNull(),
  documentFileType: varchar("document_file_type", { length: 100 }),
  documentFileSize: integer("document_file_size"),
  rejectionReason: text("rejection_reason"),
  reviewNote: text("review_note"),
  reviewedBy: integer("reviewed_by").references(() => backofficeUsers.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  resubmissionCount: integer("resubmission_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const eventImages = pgTable("event_images", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  imageUrl: varchar("image_url", { length: 500 }).notNull(),
  caption: varchar("caption", { length: 255 }),
  imageType: varchar("image_type", { length: 50 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 3A. SPONSORSHIP
// --------------------------------------------------------------------------
export const sponsorEventProfiles = pgTable("sponsor_event_profiles", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" })
    .unique(),
  aboutTitle: varchar("about_title", { length: 255 }),
  aboutDescription: text("about_description"),
  organizerLogoUrl: varchar("organizer_logo_url", { length: 2000 }),
  brochureUrl: varchar("brochure_url", { length: 2000 }),
  registrationOpenAt: timestamp("registration_open_at"),
  registrationCloseAt: timestamp("registration_close_at"),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorStats = pgTable("sponsor_stats", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  valueText: varchar("value_text", { length: 50 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorPackages = pgTable("sponsor_packages", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  packageType: sponsorPackageTypeEnum("package_type").notNull(),
  code: varchar("code", { length: 50 }).notNull(),
  optionLabel: varchar("option_label", { length: 100 }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: decimal("price", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  quota: integer("quota").notNull().default(0),
  badgeText: varchar("badge_text", { length: 100 }),
  themeKey: varchar("theme_key", { length: 50 }),
  isRecommended: boolean("is_recommended").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorPackageFeatures = pgTable("sponsor_package_features", {
  id: serial("id").primaryKey(),
  packageId: integer("package_id")
    .notNull()
    .references(() => sponsorPackages.id, { onDelete: "cascade" }),
  featureText: varchar("feature_text", { length: 500 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sponsorPackageComponents = pgTable("sponsor_package_components", {
  id: serial("id").primaryKey(),
  bundlePackageId: integer("bundle_package_id")
    .notNull()
    .references(() => sponsorPackages.id, { onDelete: "cascade" }),
  componentPackageId: integer("component_package_id")
    .notNull()
    .references(() => sponsorPackages.id, { onDelete: "cascade" }),
  componentRole: varchar("component_role", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sponsorBenefits = pgTable("sponsor_benefits", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  iconKey: varchar("icon_key", { length: 50 }),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorMediaAssets = pgTable("sponsor_media_assets", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  mediaType: sponsorMediaTypeEnum("media_type").notNull(),
  title: varchar("title", { length: 255 }),
  caption: varchar("caption", { length: 500 }),
  fileUrl: varchar("file_url", { length: 2000 }).notNull(),
  fileName: varchar("file_name", { length: 255 }),
  mimeType: varchar("mime_type", { length: 100 }),
  fileSize: integer("file_size"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorTimelineItems = pgTable("sponsor_timeline_items", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  periodLabel: varchar("period_label", { length: 100 }).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  startDate: timestamp("start_date"),
  endDate: timestamp("end_date"),
  isHighlight: boolean("is_highlight").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorApplications = pgTable("sponsor_applications", {
  id: serial("id").primaryKey(),
  applicationNo: varchar("application_no", { length: 50 }).notNull().unique(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  companyName: varchar("company_name", { length: 255 }).notNull(),
  contactFullName: varchar("contact_full_name", { length: 255 }).notNull(),
  businessEmail: varchar("business_email", { length: 255 }).notNull(),
  phone: varchar("phone", { length: 50 }).notNull(),
  billingName: varchar("billing_name", { length: 255 }).notNull(),
  taxId: varchar("tax_id", { length: 13 }).notNull(),
  billingAddress: text("billing_address").notNull(),
  paymentSlipUrl: varchar("payment_slip_url", { length: 2000 }),
  paymentSlipFileName: varchar("payment_slip_file_name", { length: 255 }),
  logoUrl: varchar("logo_url", { length: 2000 }),
  logoFileName: varchar("logo_file_name", { length: 255 }),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  applicationStatus: sponsorApplicationStatusEnum("application_status")
    .notNull()
    .default("submitted"),
  paymentStatus: sponsorPaymentStatusEnum("payment_status")
    .notNull()
    .default("pending_review"),
  internalNote: text("internal_note"),
  rejectionReason: text("rejection_reason"),
  reviewedBy: integer("reviewed_by").references(() => backofficeUsers.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sponsorApplicationItems = pgTable("sponsor_application_items", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id")
    .notNull()
    .references(() => sponsorApplications.id, { onDelete: "cascade" }),
  packageId: integer("package_id").references(() => sponsorPackages.id, {
    onDelete: "set null",
  }),
  packageType: sponsorPackageTypeEnum("package_type").notNull(),
  packageNameSnapshot: varchar("package_name_snapshot", { length: 255 }).notNull(),
  priceSnapshot: decimal("price_snapshot", { precision: 10, scale: 2 }).notNull().default("0"),
  quantity: integer("quantity").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const eventAttachments = pgTable("event_attachments", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileUrl: varchar("file_url", { length: 500 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  fileSize: integer("file_size"),
  description: varchar("description", { length: 500 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 4. TICKETS & PROMO CODES
// --------------------------------------------------------------------------
export const ticketTypes = pgTable("ticket_types", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  category: ticketCategoryEnum("category").notNull(),
  priority: ticketPriorityEnum("priority").notNull().default("regular"),
  groupName: varchar("group_name", { length: 100 }),
  name: varchar("name", { length: 100 }).notNull(),
  sessionId: integer("session_id").references(() => sessions.id), // Deprecated: use ticketSessions for multi-session
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  allowedRoles: text("allowed_roles"),
  allowedStudentLevels: text("allowed_student_levels"), // CSV: "postgraduate,undergraduate" or null for all
  quota: integer("quota").notNull(),
  soldCount: integer("sold_count").notNull().default(0),
  saleStartDate: timestamp("sale_start_date"),
  saleEndDate: timestamp("sale_end_date"),
  // Phase 1A: Additional columns for ticket display
  description: text("description"),
  originalPrice: decimal("original_price", { precision: 10, scale: 2 }),
  features: jsonb("features").$type<string[]>().default([]),
  badgeText: varchar("badge_text", { length: 50 }),
  displayOrder: integer("display_order").default(0),
  isActive: boolean("is_active").default(true),
});

// Junction table for many-to-many: Ticket <-> Sessions
export const ticketSessions = pgTable("ticket_sessions", {
  id: serial("id").primaryKey(),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id, { onDelete: "cascade" }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
});

export const promoCodes = pgTable("promo_codes", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => events.id),
  ticketTypeId: integer("ticket_type_id").references(() => ticketTypes.id),
  code: varchar("code", { length: 50 }).notNull().unique(),
  description: text("description"),
  discountType: varchar("discount_type", { length: 20 }).notNull(), // 'percentage' | 'fixed'
  discountValue: decimal("discount_value", {
    precision: 10,
    scale: 2,
  }).notNull(), // used for percentage
  fixedValueThb: decimal("fixed_value_thb", { precision: 10, scale: 2 }),
  fixedValueUsd: decimal("fixed_value_usd", { precision: 10, scale: 2 }),
  minPurchase: decimal("min_purchase", { precision: 10, scale: 2 }).default("0"),
  maxDiscount: decimal("max_discount", { precision: 10, scale: 2 }),
  maxUses: integer("max_uses").notNull(),
  maxUsesPerUser: integer("max_uses_per_user").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Rule sets: which ticket combinations a promo code applies to
export const promoCodeRuleSets = pgTable("promo_code_rule_sets", {
  id: serial("id").primaryKey(),
  promoCodeId: integer("promo_code_id")
    .notNull()
    .references(() => promoCodes.id, { onDelete: "cascade" }),
  matchType: varchar("match_type", { length: 10 }).notNull().default("all"), // 'all' | 'any' | 'only'
});

export const promoCodeRuleItems = pgTable("promo_code_rule_items", {
  id: serial("id").primaryKey(),
  ruleSetId: integer("rule_set_id")
    .notNull()
    .references(() => promoCodeRuleSets.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id, { onDelete: "cascade" }),
});

// Promo code usage tracking (pending reservation pattern)
export const promoCodeUsages = pgTable("promo_code_usages", {
  id: serial("id").primaryKey(),
  promoCodeId: integer("promo_code_id")
    .notNull()
    .references(() => promoCodes.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  orderId: integer("order_id")
    .references(() => orders.id),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // 'pending' | 'used' | 'cancelled' | 'expired'
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }),
  reservedAt: timestamp("reserved_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  cancelledAt: timestamp("cancelled_at"),
});

// --------------------------------------------------------------------------
// 5. ORDERS & PAYMENTS
// --------------------------------------------------------------------------
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  eventId: integer("event_id").references(() => events.id),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  subtotalAmount: decimal("subtotal_amount", { precision: 10, scale: 2 }),
  discountAmount: decimal("discount_amount", { precision: 10, scale: 2 }).default("0"),
  promoCodeId: integer("promo_code_id").references(() => promoCodes.id),
  promoCode: varchar("promo_code", { length: 50 }),
  promoDiscountType: varchar("promo_discount_type", { length: 20 }),
  promoDiscountValue: decimal("promo_discount_value", { precision: 10, scale: 2 }),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  status: orderStatusEnum("status").notNull().default("pending"),
  needTaxInvoice: boolean("need_tax_invoice").notNull().default(false),
  taxName: varchar("tax_name", { length: 200 }),
  taxId: varchar("tax_id", { length: 50 }),
  taxAddress: varchar("tax_address", { length: 500 }),
  taxSubDistrict: varchar("tax_sub_district", { length: 100 }),
  taxDistrict: varchar("tax_district", { length: 100 }),
  taxProvince: varchar("tax_province", { length: 100 }),
  taxPostalCode: varchar("tax_postal_code", { length: 20 }),
  taxFullAddress: text("tax_full_address"),
  taxCreatedAt: timestamp("tax_created_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 6. REGISTRATION & CHECK-IN
// --------------------------------------------------------------------------
export const registrations = pgTable("registrations", {
  id: serial("id").primaryKey(),
  regCode: varchar("reg_code", { length: 50 }).notNull().unique(),
  orderId: integer("order_id").references(() => orders.id),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  sessionId: integer("session_id").references(() => sessions.id), // DEPRECATED: use registration_sessions
  userId: integer("user_id").references(() => users.id),
  email: varchar("email", { length: 255 }).notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  dietaryRequirements: varchar("dietary_requirements", { length: 255 }),
  status: registrationStatusEnum("status").notNull().default("confirmed"),
  source: varchar("source", { length: 20 }).notNull().default("purchase"),
  attendeeType: varchar("attendee_type", { length: 20 }), // e.g. 'parent', 'student' — used by quick-register flow
  addedBy: integer("added_by").references(() => backofficeUsers.id),
  addedNote: text("added_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Junction table: 1 registration → N sessions (tracks which sessions a registrant has access to)
export const registrationSessions = pgTable("registration_sessions", {
  id: serial("id").primaryKey(),
  registrationId: integer("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  checkedInAt: timestamp("checked_in_at"),
  checkedInBy: integer("checked_in_by")
    .references(() => backofficeUsers.id),
  source: varchar("source", { length: 20 }).notNull().default("purchase"),
  addedBy: integer("added_by").references(() => backofficeUsers.id),
  addedNote: text("added_note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  itemType: orderItemTypeEnum("item_type").notNull(),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  registrationId: integer("registration_id").references(() => registrations.id),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
});

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  paymentChannel: varchar("payment_channel", { length: 50 }),
  paymentDetails: jsonb("payment_details"),
  paymentProvider: varchar("payment_provider", { length: 30 }).notNull().default("stripe"),
  providerRef: varchar("provider_ref", { length: 255 }),
  providerStatus: varchar("provider_status", { length: 50 }),
  paySolutionsRefno: varchar("pay_solutions_refno", { length: 12 }),
  paySolutionsOrderNo: varchar("pay_solutions_order_no", { length: 50 }),
  paySolutionsChannel: varchar("pay_solutions_channel", { length: 20 }),
  stripeReceiptUrl: varchar("stripe_receipt_url", { length: 500 }),
  stripeSessionId: varchar("stripe_session_id", { length: 255 }),
  paidAt: timestamp("paid_at"),
});

export const registrationAddons = pgTable("registration_addons", {
  id: serial("id").primaryKey(),
  registrationId: integer("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status").default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const checkIns = pgTable("check_ins", {
  id: serial("id").primaryKey(),
  registrationId: integer("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  scannedAt: timestamp("scanned_at").notNull().defaultNow(),
  scannedBy: integer("scanned_by").references(() => users.id),
});

// --------------------------------------------------------------------------
// 7. ABSTRACTS & SPEAKERS
// --------------------------------------------------------------------------

// Abstract categories per event (dynamic, replaces hardcoded enum)
export const abstractCategories = pgTable("abstract_categories", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const speakers = pgTable("speakers", {
  id: serial("id").primaryKey(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  bio: text("bio"),
  photoUrl: varchar("photo_url", { length: 500 }),
  organization: varchar("organization", { length: 255 }),
  position: varchar("position", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const eventSpeakers = pgTable("event_speakers", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  speakerId: integer("speaker_id")
    .notNull()
    .references(() => speakers.id),
  sessionId: integer("session_id").references(() => sessions.id),
  speakerType: speakerTypeEnum("speaker_type").notNull(),
  topic: varchar("topic", { length: 255 }),
  presentationFileUrl: varchar("presentation_file_url", { length: 500 }),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const abstracts = pgTable("abstracts", {
  id: serial("id").primaryKey(),
  trackingId: varchar("tracking_id", { length: 20 }).unique(),
  userId: integer("user_id").references(() => users.id),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  title: varchar("title", { length: 500 }).notNull(),
  categoryId: integer("category_id")
    .notNull()
    .references(() => abstractCategories.id),
  presentationType: presentationTypeEnum("presentation_type").notNull(),
  keywords: varchar("keywords", { length: 255 }),
  background: text("background").notNull(),
  objective: text("objective").notNull(),
  methods: text("methods").notNull(),
  results: text("results").notNull(),
  conclusion: text("conclusion").notNull(),
  fullPaperUrl: varchar("full_paper_url", { length: 500 }),
  status: abstractStatusEnum("status").notNull().default("pending"),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  confirmedAt: timestamp("confirmed_at"),
  reviewComment: text("review_comment"),
  reviewedBy: integer("reviewed_by").references(() => backofficeUsers.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Token rows for the approval-confirmation flow.
// Raw token is sent only via email; only the SHA-256 hash is stored here.
export const abstractConfirmations = pgTable("abstract_confirmations", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const abstractFiles = pgTable("abstract_files", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileUrl: varchar("file_url", { length: 500 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  fileSize: integer("file_size"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const abstractCoAuthors = pgTable("abstract_co_authors", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  institution: varchar("institution", { length: 255 }),
  country: varchar("country", { length: 100 }),
  sortOrder: integer("sort_order").default(0),
});

export const abstractReviews = pgTable("abstract_reviews", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id),
  reviewerId: integer("reviewer_id")
    .notNull()
    .references(() => users.id),
  status: abstractStatusEnum("status").notNull(),
  comment: text("comment"),
  reviewedAt: timestamp("reviewed_at").notNull().defaultNow(),
});

export const abstractRevisionRequests = pgTable("abstract_revision_requests", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  requestedBy: integer("requested_by").references(() => backofficeUsers.id),
  topic: varchar("topic", { length: 50 }).notNull(),
  comment: text("comment").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  resubmittedAt: timestamp("resubmitted_at"),
});

export const abstractRevisionRequestFiles = pgTable("abstract_revision_request_files", {
  id: serial("id").primaryKey(),
  revisionRequestId: integer("revision_request_id")
    .notNull()
    .references(() => abstractRevisionRequests.id, { onDelete: "cascade" }),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileUrl: varchar("file_url", { length: 500 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  fileSize: integer("file_size"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 8. VERIFICATION REJECTION HISTORY
// --------------------------------------------------------------------------
export const verificationRejectionHistory = pgTable(
  "verification_rejection_history",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    rejectedBy: integer("rejected_by").references(() => backofficeUsers.id),
    rejectedAt: timestamp("rejected_at").notNull().defaultNow(),
  },
);

// --------------------------------------------------------------------------
// TYPE EXPORTS
// --------------------------------------------------------------------------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type TicketType = typeof ticketTypes.$inferSelect;
export type NewTicketType = typeof ticketTypes.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;

export type Speaker = typeof speakers.$inferSelect;
export type NewSpeaker = typeof speakers.$inferInsert;

export type Abstract = typeof abstracts.$inferSelect;
export type NewAbstract = typeof abstracts.$inferInsert;
export type AbstractConfirmation = typeof abstractConfirmations.$inferSelect;
export type NewAbstractConfirmation = typeof abstractConfirmations.$inferInsert;
export type AbstractFile = typeof abstractFiles.$inferSelect;
export type NewAbstractFile = typeof abstractFiles.$inferInsert;
export type AbstractRevisionRequest = typeof abstractRevisionRequests.$inferSelect;
export type NewAbstractRevisionRequest = typeof abstractRevisionRequests.$inferInsert;
export type AbstractRevisionRequestFile = typeof abstractRevisionRequestFiles.$inferSelect;
export type NewAbstractRevisionRequestFile = typeof abstractRevisionRequestFiles.$inferInsert;

export type BackofficeUser = typeof backofficeUsers.$inferSelect;
export type NewBackofficeUser = typeof backofficeUsers.$inferInsert;

export type StaffEventAssignment = typeof staffEventAssignments.$inferSelect;
export type NewStaffEventAssignment = typeof staffEventAssignments.$inferInsert;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

export type RegistrationSession = typeof registrationSessions.$inferSelect;
export type NewRegistrationSession = typeof registrationSessions.$inferInsert;

export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;

export type PromoCodeRuleSet = typeof promoCodeRuleSets.$inferSelect;
export type PromoCodeRuleItem = typeof promoCodeRuleItems.$inferSelect;

export type PromoCodeUsage = typeof promoCodeUsages.$inferSelect;
export type NewPromoCodeUsage = typeof promoCodeUsages.$inferInsert;

export type AbstractCategory = typeof abstractCategories.$inferSelect;
export type NewAbstractCategory = typeof abstractCategories.$inferInsert;

export type EventStudentEligibilityRequest = typeof eventStudentEligibilityRequests.$inferSelect;
export type NewEventStudentEligibilityRequest = typeof eventStudentEligibilityRequests.$inferInsert;

export type SponsorEventProfile = typeof sponsorEventProfiles.$inferSelect;
export type NewSponsorEventProfile = typeof sponsorEventProfiles.$inferInsert;
export type SponsorStat = typeof sponsorStats.$inferSelect;
export type NewSponsorStat = typeof sponsorStats.$inferInsert;
export type SponsorPackage = typeof sponsorPackages.$inferSelect;
export type NewSponsorPackage = typeof sponsorPackages.$inferInsert;
export type SponsorPackageFeature = typeof sponsorPackageFeatures.$inferSelect;
export type NewSponsorPackageFeature = typeof sponsorPackageFeatures.$inferInsert;
export type SponsorPackageComponent = typeof sponsorPackageComponents.$inferSelect;
export type NewSponsorPackageComponent = typeof sponsorPackageComponents.$inferInsert;
export type SponsorBenefit = typeof sponsorBenefits.$inferSelect;
export type NewSponsorBenefit = typeof sponsorBenefits.$inferInsert;
export type SponsorMediaAsset = typeof sponsorMediaAssets.$inferSelect;
export type NewSponsorMediaAsset = typeof sponsorMediaAssets.$inferInsert;
export type SponsorTimelineItem = typeof sponsorTimelineItems.$inferSelect;
export type NewSponsorTimelineItem = typeof sponsorTimelineItems.$inferInsert;
export type SponsorApplication = typeof sponsorApplications.$inferSelect;
export type NewSponsorApplication = typeof sponsorApplications.$inferInsert;
export type SponsorApplicationItem = typeof sponsorApplicationItems.$inferSelect;
export type NewSponsorApplicationItem = typeof sponsorApplicationItems.$inferInsert;

// --------------------------------------------------------------------------
// 8. RELATIONS
// --------------------------------------------------------------------------

export const registrationsRelations = relations(registrations, ({ one, many }) => ({
  event: one(events, {
    fields: [registrations.eventId],
    references: [events.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [registrations.ticketTypeId],
    references: [ticketTypes.id],
  }),
  session: one(sessions, {
    fields: [registrations.sessionId],
    references: [sessions.id],
  }),
  order: one(orders, {
    fields: [registrations.orderId],
    references: [orders.id],
  }),
  user: one(users, {
    fields: [registrations.userId],
    references: [users.id],
  }),
  registrationSessions: many(registrationSessions),
}));

export const registrationSessionsRelations = relations(registrationSessions, ({ one }) => ({
  registration: one(registrations, {
    fields: [registrationSessions.registrationId],
    references: [registrations.id],
  }),
  session: one(sessions, {
    fields: [registrationSessions.sessionId],
    references: [sessions.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [registrationSessions.ticketTypeId],
    references: [ticketTypes.id],
  }),
}));

export const checkInsRelations = relations(checkIns, ({ one }) => ({
  registration: one(registrations, {
    fields: [checkIns.registrationId],
    references: [registrations.id],
  }),
  scannedBy: one(users, {
    fields: [checkIns.scannedBy],
    references: [users.id],
  }),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  registrations: many(registrations),
  sessions: many(sessions),
  eventSpeakers: many(eventSpeakers),
  ticketTypes: many(ticketTypes),
  studentEligibilityRequests: many(eventStudentEligibilityRequests),
  sponsorStats: many(sponsorStats),
  sponsorPackages: many(sponsorPackages),
  sponsorBenefits: many(sponsorBenefits),
  sponsorMediaAssets: many(sponsorMediaAssets),
  sponsorTimelineItems: many(sponsorTimelineItems),
  sponsorApplications: many(sponsorApplications),
}));

export const eventStudentEligibilityRequestsRelations = relations(eventStudentEligibilityRequests, ({ one }) => ({
  event: one(events, {
    fields: [eventStudentEligibilityRequests.eventId],
    references: [events.id],
  }),
  user: one(users, {
    fields: [eventStudentEligibilityRequests.userId],
    references: [users.id],
  }),
  reviewer: one(backofficeUsers, {
    fields: [eventStudentEligibilityRequests.reviewedBy],
    references: [backofficeUsers.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  event: one(events, {
    fields: [sessions.eventId],
    references: [events.id],
  }),
  eventSpeakers: many(eventSpeakers),
  registrationSessions: many(registrationSessions),
}));

export const speakersRelations = relations(speakers, ({ many }) => ({
  eventSpeakers: many(eventSpeakers),
}));

export const eventSpeakersRelations = relations(eventSpeakers, ({ one }) => ({
  event: one(events, {
    fields: [eventSpeakers.eventId],
    references: [events.id],
  }),
  speaker: one(speakers, {
    fields: [eventSpeakers.speakerId],
    references: [speakers.id],
  }),
  session: one(sessions, {
    fields: [eventSpeakers.sessionId],
    references: [sessions.id],
  }),
}));

export const ticketTypesRelations = relations(ticketTypes, ({ many }) => ({
  registrations: many(registrations),
  ticketSessions: many(ticketSessions),
}));

export const sponsorEventProfilesRelations = relations(sponsorEventProfiles, ({ one }) => ({
  event: one(events, {
    fields: [sponsorEventProfiles.eventId],
    references: [events.id],
  }),
}));

export const sponsorStatsRelations = relations(sponsorStats, ({ one }) => ({
  event: one(events, {
    fields: [sponsorStats.eventId],
    references: [events.id],
  }),
}));

export const sponsorPackagesRelations = relations(sponsorPackages, ({ one, many }) => ({
  event: one(events, {
    fields: [sponsorPackages.eventId],
    references: [events.id],
  }),
  features: many(sponsorPackageFeatures),
  bundleComponents: many(sponsorPackageComponents, {
    relationName: "bundle_package_components",
  }),
  includedInBundles: many(sponsorPackageComponents, {
    relationName: "component_package_components",
  }),
  applicationItems: many(sponsorApplicationItems),
}));

export const sponsorPackageFeaturesRelations = relations(sponsorPackageFeatures, ({ one }) => ({
  package: one(sponsorPackages, {
    fields: [sponsorPackageFeatures.packageId],
    references: [sponsorPackages.id],
  }),
}));

export const sponsorPackageComponentsRelations = relations(sponsorPackageComponents, ({ one }) => ({
  bundlePackage: one(sponsorPackages, {
    fields: [sponsorPackageComponents.bundlePackageId],
    references: [sponsorPackages.id],
    relationName: "bundle_package_components",
  }),
  componentPackage: one(sponsorPackages, {
    fields: [sponsorPackageComponents.componentPackageId],
    references: [sponsorPackages.id],
    relationName: "component_package_components",
  }),
}));

export const sponsorBenefitsRelations = relations(sponsorBenefits, ({ one }) => ({
  event: one(events, {
    fields: [sponsorBenefits.eventId],
    references: [events.id],
  }),
}));

export const sponsorMediaAssetsRelations = relations(sponsorMediaAssets, ({ one }) => ({
  event: one(events, {
    fields: [sponsorMediaAssets.eventId],
    references: [events.id],
  }),
}));

export const sponsorTimelineItemsRelations = relations(sponsorTimelineItems, ({ one }) => ({
  event: one(events, {
    fields: [sponsorTimelineItems.eventId],
    references: [events.id],
  }),
}));

export const sponsorApplicationsRelations = relations(sponsorApplications, ({ one, many }) => ({
  event: one(events, {
    fields: [sponsorApplications.eventId],
    references: [events.id],
  }),
  reviewer: one(backofficeUsers, {
    fields: [sponsorApplications.reviewedBy],
    references: [backofficeUsers.id],
  }),
  items: many(sponsorApplicationItems),
}));

export const sponsorApplicationItemsRelations = relations(sponsorApplicationItems, ({ one }) => ({
  application: one(sponsorApplications, {
    fields: [sponsorApplicationItems.applicationId],
    references: [sponsorApplications.id],
  }),
  package: one(sponsorPackages, {
    fields: [sponsorApplicationItems.packageId],
    references: [sponsorPackages.id],
  }),
}));
