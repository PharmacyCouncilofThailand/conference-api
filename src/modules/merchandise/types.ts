import type { WheelImageStorage } from "../lucky-wheel/images.js";
import type { MerchDb } from "./db.js";
import type { PaysoClient, PaysoConfig } from "./payments/payso-client.js";

export interface MerchRouteOptions {
  database: MerchDb;
  payso: PaysoClient | null;
  paysoConfig: PaysoConfig | null;
  nodeEnv: string;
  imageStorage?: WheelImageStorage;
}

export type Baht = number; // whole THB, integer
export interface ImageAsset { id: string; url: string; width: number; height: number }
export interface StoreDto {
  eventId: number; eventCode: string;
  state: "disabled" | "not_open" | "open" | "closed";
  opensAt: string | null; closesAt: string | null;
  productionInfoTh: string | null; shippingInfoTh: string | null;
  shippingBaht: 50; currency: "THB"; serverNow: string;
  categories: { id: string; nameTh: string; sortOrder: number }[];
  banners: { id: string; image: ImageAsset; linkUrl: string | null }[];
}
export interface VariantDto {
  id: string; sizeTh: string | null; colorTh: string | null;
  priceBaht: Baht | null; saleEnabled: boolean;
}
export interface BundleComponentDto {
  id: string; productId: string; nameTh: string; quantityPerBundle: number;
  mode: "fixed" | "selectable"; fixedVariant: VariantDto | null; allowedVariants: VariantDto[];
}
export interface ProductDto {
  id: string; kind: "single" | "bundle"; nameTh: string;
  descriptionTh: string | null; sizeChartTh: string | null;
  images: ImageAsset[]; categoryId: string | null; sortOrder: number;
  hasOptions: boolean; // false = hide the option picker
  variants: VariantDto[]; components: BundleComponentDto[];
  price: { kind: "exact" | "from"; amountBaht: Baht } | null;
  purchasable: boolean; unavailableCodes: string[];
}
export interface BundleSelection { componentId: string; variantId: string }
export interface CartLine {
  id: string; productId: string; variantId: string | null; bundleSelections: BundleSelection[];
  quantity: number; product: ProductDto | null;
  unitPriceBaht: Baht | null; lineTotalBaht: Baht | null;
  valid: boolean; issueCodes: string[];
}
export interface Amounts { subtotalBaht: Baht; shippingBaht: 50; totalBaht: Baht; currency: "THB" }
export interface CartDto {
  cartVersion: string; items: CartLine[]; amounts: Amounts | null;
  buyerDefaults: { fullName: string; phone: string | null; email: string };
  serverNow: string;
}
export interface Recipient {
  fullName: string; phone: string; addressLine: string; subdistrict: string;
  district: string; province: string; postalCode: string;
  company: string | null; deliveryNote: string | null;
}
export interface OrderItemDto {
  id: string; kind: "single" | "bundle"; nameTh: string; sizeTh: string | null; colorTh: string | null;
  quantity: number; unitPriceBaht: Baht; lineTotalBaht: Baht;
  components: { nameTh: string; sizeTh: string | null; colorTh: string | null; quantityPerBundle: number }[];
}
export interface OrderSummary {
  id: string; orderNumber: string; createdAt: string;
  paymentStatus: "pending" | "paid" | "expired"; paidAt: string | null;
  shipping: { status: "not_shipped" | "shipped"; carrier: string | null; trackingId: string | null; shippedAt: string | null };
  amounts: Amounts;
}

export type PaymentState =
  | "awaiting_qr"        // no usable QR and one can be requested
  | "qr_active"          // an unexpired QR exists
  | "verifying"          // expired less than 2 minutes ago
  | "qr_expired_open"    // QR expired, can request a new one
  | "qr_expired_closed"  // store closed, payment window over
  | "check_failed"       // latest inquiry failed
  | "review"             // attempt awaiting staff review, order not paid
  | "paid";
export interface PaymentView {
  state: PaymentState;
  attempt: { id: string; referenceNo: string; expiresAt: string | null; qrPayload: string | null } | null;
  canRequestNewQr: boolean;
  canCheck: boolean;
  retryAfterSeconds: number | null;
  serverNow: string;
}

export interface OrderDetail extends OrderSummary {
  buyer: { name: string; email: string; phone: string | null };
  recipient: Recipient; items: OrderItemDto[];
  productionInfoTh: string | null; shippingInfoTh: string | null;
  payment: PaymentView;
}
export interface AdminOrderDetail extends OrderDetail {
  version: number;
  attempts: { id: string; referenceNo: string; providerOrderNo: string | null; transactionId: string | null;
    amountBaht: Baht; status: string; requestedAt: string; expiresAt: string | null; paidAt: string | null;
    lastCheckAt: string | null; lastCheckResult: string | null; reviewReason: string | null; reviewResolvedAt: string | null }[];
  notifications: { type: "paid" | "shipped"; status: string; attempts: number; lastErrorCode: string | null; sentAt: string | null }[];
  audit: { action: string; actorId: number | null; reason: string | null; contactNote: string | null; createdAt: string; before: unknown; after: unknown }[];
}
export interface ProductionRow {
  productId: string; nameTh: string; sizeTh: string | null; colorTh: string | null;
  singleQuantity: number; bundleQuantity: number; totalQuantity: number;
}

export interface AdminVariantDto extends VariantDto { sortOrder: number; version: number }
export interface AdminComponentDto {
  id: string; componentProductId: string; quantityPerBundle: number; mode: "fixed" | "selectable";
  fixedVariantId: string | null; allowedVariantIds: string[]; sortOrder: number;
}
export interface AdminProductDto {
  id: string; kind: "single" | "bundle"; nameTh: string; descriptionTh: string | null; sizeChartTh: string | null;
  images: ImageAsset[]; categoryId: string | null; sortOrder: number;
  publishState: "draft" | "published"; saleEnabled: boolean; basePriceBaht: Baht | null; version: number;
  variants: AdminVariantDto[]; components: AdminComponentDto[];
  publishIssues: string[]; // what is missing before publish (empty = publishable)
  purchasable: boolean; unavailableCodes: string[];
}
export interface AdminCategoryDto { id: string; nameTh: string; sortOrder: number; visible: boolean; version: number }
export interface AdminBannerDto { id: string; image: ImageAsset; linkUrl: string | null; active: boolean; sortOrder: number; version: number }
export interface AdminStoreDto extends StoreDto { enabled: boolean; version: number }
export interface BatchRowResult { id: string; ok: boolean; code: string | null; error: string | null }
export interface PaymentReviewDto {
  attemptId: string; orderId: string; orderNumber: string; referenceNo: string; amountBaht: Baht;
  reviewReason: string; createdAt: string; resolvedAt: string | null; note: string | null;
}
