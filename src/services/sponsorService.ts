import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../database/index.js";
import {
  events,
  sponsorApplications,
  sponsorApplicationItems,
  sponsorBenefits,
  sponsorEventProfiles,
  sponsorMediaAssets,
  sponsorPackageComponents,
  sponsorPackageFeatures,
  sponsorPackages,
  sponsorStats,
  sponsorTimelineItems,
} from "../database/schema.js";

type SponsorPackageFeatureRow = typeof sponsorPackageFeatures.$inferSelect;
type SponsorPackageComponentRow = typeof sponsorPackageComponents.$inferSelect;

type SponsorPageOptions = {
  includeInactive?: boolean;
  requirePublishedEvent?: boolean;
  requirePublishedProfile?: boolean;
};

export function generateSponsorApplicationNo(eventCode: string): string {
  const prefix = eventCode.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 16) || "EVENT";
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SPN-${prefix}-${ts}${rand}`;
}

export async function getEventByIdOrCode(identifier: string | number) {
  const id = String(identifier);
  const isNumeric = /^\d+$/.test(id);

  const [event] = await db
    .select({
      id: events.id,
      eventCode: events.eventCode,
      eventName: events.eventName,
      shortName: events.shortName,
      description: events.description,
      startDate: events.startDate,
      endDate: events.endDate,
      location: events.location,
      status: events.status,
      imageUrl: events.imageUrl,
      coverImage: events.coverImage,
      videoUrl: events.videoUrl,
      documents: events.documents,
    })
    .from(events)
    .where(isNumeric ? eq(events.id, parseInt(id, 10)) : eq(events.eventCode, id))
    .limit(1);

  return event || null;
}

export async function getSponsorPackageReservedCounts(packageIds: number[], client: any = db) {
  if (packageIds.length === 0) return {};

  const directRows = await client
    .select({
      packageId: sponsorApplicationItems.packageId,
      reservedCount: sql<number>`coalesce(sum(${sponsorApplicationItems.quantity}), 0)::int`,
    })
    .from(sponsorApplicationItems)
    .innerJoin(
      sponsorApplications,
      eq(sponsorApplicationItems.applicationId, sponsorApplications.id),
    )
    .where(
      and(
        inArray(sponsorApplicationItems.packageId, packageIds),
        sql`${sponsorApplications.applicationStatus} not in ('rejected', 'cancelled')`,
        sql`${sponsorApplications.paymentStatus} <> 'rejected'`,
      ),
    )
    .groupBy(sponsorApplicationItems.packageId);

  const bundleComponentRows = await client
    .select({
      packageId: sponsorPackageComponents.componentPackageId,
      reservedCount: sql<number>`coalesce(sum(${sponsorApplicationItems.quantity}), 0)::int`,
    })
    .from(sponsorApplicationItems)
    .innerJoin(
      sponsorApplications,
      eq(sponsorApplicationItems.applicationId, sponsorApplications.id),
    )
    .innerJoin(
      sponsorPackageComponents,
      eq(sponsorPackageComponents.bundlePackageId, sponsorApplicationItems.packageId),
    )
    .where(
      and(
        inArray(sponsorPackageComponents.componentPackageId, packageIds),
        sql`${sponsorApplications.applicationStatus} not in ('rejected', 'cancelled')`,
        sql`${sponsorApplications.paymentStatus} <> 'rejected'`,
      ),
    )
    .groupBy(sponsorPackageComponents.componentPackageId);

  return [...directRows, ...bundleComponentRows].reduce<Record<number, number>>((acc, row) => {
    if (row.packageId != null) {
      acc[row.packageId] = (acc[row.packageId] || 0) + Number(row.reservedCount || 0);
    }
    return acc;
  }, {});
}

export async function getSponsorPage(identifier: string | number, options: SponsorPageOptions = {}) {
  const includeInactive = options.includeInactive ?? false;
  const event = await getEventByIdOrCode(identifier);

  if (!event) return null;
  if (options.requirePublishedEvent && event.status !== "published") return null;

  const [profile] = await db
    .select()
    .from(sponsorEventProfiles)
    .where(eq(sponsorEventProfiles.eventId, event.id))
    .limit(1);

  if (options.requirePublishedProfile && (!profile || !profile.isPublished)) {
    return null;
  }

  const activeStatConditions = [eq(sponsorStats.eventId, event.id)];
  const activePackageConditions = [eq(sponsorPackages.eventId, event.id)];
  const activeBenefitConditions = [eq(sponsorBenefits.eventId, event.id)];
  const activeMediaConditions = [eq(sponsorMediaAssets.eventId, event.id)];
  const activeTimelineConditions = [eq(sponsorTimelineItems.eventId, event.id)];

  if (!includeInactive) {
    activeStatConditions.push(eq(sponsorStats.isActive, true));
    activePackageConditions.push(eq(sponsorPackages.isActive, true));
    activeBenefitConditions.push(eq(sponsorBenefits.isActive, true));
    activeMediaConditions.push(eq(sponsorMediaAssets.isActive, true));
    activeTimelineConditions.push(eq(sponsorTimelineItems.isActive, true));
  }

  const [
    stats,
    packageRows,
    benefits,
    mediaAssets,
    timeline,
  ] = await Promise.all([
    db
      .select()
      .from(sponsorStats)
      .where(and(...activeStatConditions))
      .orderBy(asc(sponsorStats.sortOrder), asc(sponsorStats.id)),
    db
      .select()
      .from(sponsorPackages)
      .where(and(...activePackageConditions))
      .orderBy(asc(sponsorPackages.packageType), asc(sponsorPackages.sortOrder), asc(sponsorPackages.id)),
    db
      .select()
      .from(sponsorBenefits)
      .where(and(...activeBenefitConditions))
      .orderBy(asc(sponsorBenefits.sortOrder), asc(sponsorBenefits.id)),
    db
      .select()
      .from(sponsorMediaAssets)
      .where(and(...activeMediaConditions))
      .orderBy(asc(sponsorMediaAssets.mediaType), asc(sponsorMediaAssets.sortOrder), asc(sponsorMediaAssets.id)),
    db
      .select()
      .from(sponsorTimelineItems)
      .where(and(...activeTimelineConditions))
      .orderBy(asc(sponsorTimelineItems.sortOrder), asc(sponsorTimelineItems.id)),
  ]);

  const packageIds = packageRows.map((pkg) => pkg.id);
  const [features, components, reservedCounts] = await Promise.all([
    packageIds.length > 0
      ? db
        .select()
        .from(sponsorPackageFeatures)
        .where(inArray(sponsorPackageFeatures.packageId, packageIds))
        .orderBy(asc(sponsorPackageFeatures.sortOrder), asc(sponsorPackageFeatures.id))
      : [] as SponsorPackageFeatureRow[],
    packageIds.length > 0
      ? db
        .select()
        .from(sponsorPackageComponents)
        .where(inArray(sponsorPackageComponents.bundlePackageId, packageIds))
        .orderBy(asc(sponsorPackageComponents.id))
      : [] as SponsorPackageComponentRow[],
    getSponsorPackageReservedCounts(packageIds),
  ]);

  const featuresByPackage = features.reduce<Record<number, typeof features>>((acc, feature) => {
    if (!acc[feature.packageId]) acc[feature.packageId] = [];
    acc[feature.packageId].push(feature);
    return acc;
  }, {});

  const packageMap = new Map(packageRows.map((pkg) => [pkg.id, pkg]));
  const getPackageRemainingQuota = (packageId: number) => {
    const pkg = packageMap.get(packageId);
    if (!pkg || pkg.quota <= 0) return null;
    return Math.max(pkg.quota - (reservedCounts[packageId] || 0), 0);
  };

  const componentsByBundle = components.reduce<Record<number, unknown[]>>((acc, component) => {
    if (!acc[component.bundlePackageId]) acc[component.bundlePackageId] = [];
    const componentPackage = packageMap.get(component.componentPackageId);
    acc[component.bundlePackageId].push({
      ...component,
      package: componentPackage
        ? {
          id: componentPackage.id,
          packageType: componentPackage.packageType,
          code: componentPackage.code,
          name: componentPackage.name,
          price: componentPackage.price,
          currency: componentPackage.currency,
          quota: componentPackage.quota,
          reservedCount: reservedCounts[componentPackage.id] || 0,
          remainingQuota: getPackageRemainingQuota(componentPackage.id),
        }
        : null,
    });
    return acc;
  }, {});

  const packages = packageRows.map((pkg) => {
    const reservedCount = reservedCounts[pkg.id] || 0;
    const rawRemainingQuota = pkg.quota > 0 ? Math.max(pkg.quota - reservedCount, 0) : null;
    const bundleComponents = componentsByBundle[pkg.id] || [];
    const finiteComponentRemainingQuotas = bundleComponents
      .map((component: any) => component.package?.remainingQuota)
      .filter((remainingQuota): remainingQuota is number => typeof remainingQuota === "number");
    const derivesAvailabilityFromComponents = pkg.packageType === "bundle" && bundleComponents.length > 0;
    const componentRemainingQuota = finiteComponentRemainingQuotas.length > 0
      ? Math.min(...finiteComponentRemainingQuotas)
      : null;
    const effectiveRemainingQuota = derivesAvailabilityFromComponents
      ? componentRemainingQuota
      : rawRemainingQuota;
    const effectiveQuota = effectiveRemainingQuota === null
      ? null
      : reservedCount + effectiveRemainingQuota;

    return {
      ...pkg,
      reservedCount,
      remainingQuota: effectiveRemainingQuota,
      rawRemainingQuota,
      effectiveQuota,
      availabilitySource: derivesAvailabilityFromComponents ? "components" : "package",
      features: featuresByPackage[pkg.id] || [],
      components: bundleComponents,
    };
  });

  return {
    event,
    profile: profile || null,
    stats,
    packages: {
      booth: packages.filter((pkg) => pkg.packageType === "booth"),
      symposium: packages.filter((pkg) => pkg.packageType === "symposium"),
      bundle: packages.filter((pkg) => pkg.packageType === "bundle"),
    },
    benefits,
    media: {
      pastSponsors: mediaAssets.filter((item) => item.mediaType === "past_sponsor_logo"),
      previousYearImpressions: mediaAssets.filter((item) => item.mediaType === "previous_year_impression"),
      brochures: mediaAssets.filter((item) => item.mediaType === "brochure"),
      other: mediaAssets.filter((item) => item.mediaType === "other"),
    },
    timeline,
  };
}
