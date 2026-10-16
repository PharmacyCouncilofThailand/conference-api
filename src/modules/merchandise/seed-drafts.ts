import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { merchProducts, merchStores, merchVariants } from "../../database/schema.js";
import type { MerchDb } from "./db.js";
import { eventByCode } from "./store-window.js";

export const DRAFT_PRODUCT_NAMES = [
  "ผ้าห่ม",
  "แก้ว Tumbler",
  "แก้ว Mug",
  "กระบอกน้ำ",
  "กระเป๋าผ้า",
  "ถุงผ้า",
  "กระเป๋าดินสอ",
  "กระเป๋าเครื่องสำอาง",
  "ผ้าพันคอ",
  "สมุด",
  "หมอน",
] as const;

export async function seedDraftCatalog(
  db: MerchDb,
  eventCode: string,
): Promise<{ created: number; skipped: number }> {
  const event = await eventByCode(db, eventCode);
  return db.transaction(async (tx) => {
    await tx.insert(merchStores).values({ eventId: event.id, enabled: false }).onConflictDoNothing({
      target: merchStores.eventId,
    });

    let created = 0;
    let skipped = 0;
    for (const [index, nameTh] of DRAFT_PRODUCT_NAMES.entries()) {
      const [existing] = await tx
        .select({ id: merchProducts.id })
        .from(merchProducts)
        .where(
          and(
            eq(merchProducts.eventId, event.id),
            eq(merchProducts.nameTh, nameTh),
            eq(merchProducts.kind, "single"),
          ),
        )
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }
      const [product] = await tx
        .insert(merchProducts)
        .values({
          eventId: event.id,
          kind: "single",
          nameTh,
          sortOrder: index,
          publishState: "draft",
          saleEnabled: false,
        })
        .returning({ id: merchProducts.id });
      await tx.insert(merchVariants).values({ productId: product.id, sortOrder: 0 });
      created += 1;
    }
    return { created, skipped };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flagIndex = process.argv.indexOf("--event-code");
  const eventCode = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (!eventCode) {
    console.error("Usage: tsx src/modules/merchandise/seed-drafts.ts --event-code <code>");
    process.exit(1);
  }
  const { db, closeDatabase } = await import("../../database/index.js");
  try {
    const result = await seedDraftCatalog(db as unknown as MerchDb, eventCode);
    console.log(JSON.stringify(result));
    await closeDatabase();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    try {
      await closeDatabase();
    } catch {
      // ignore
    }
    process.exit(1);
  }
}
