import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { backofficeUsers } from "./schema.js";
import { config } from "dotenv";
import { eq } from "drizzle-orm";

// Load .env from root
config({ path: "./.env" });

const run = async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }

  console.log("🌱 Seeding database...");

  const client = postgres(process.env.DATABASE_URL);
  const db = drizzle(client);

  const adminEmail = process.env.ADMIN_EMAIL || "admin@conference.local";

  try {
    // Check if admin exists
    const existingAdmin = await db
      .select()
      .from(backofficeUsers)
      .where(eq(backofficeUsers.email, adminEmail));

    if (existingAdmin.length === 0) {
      console.log("Adding admin user...");
      await db.insert(backofficeUsers).values({
        email: adminEmail,
        // Hash for 'admin123'
        passwordHash:
          "$2b$12$vBN8LY9ZN75Pi/E4vwRRIuHWiIP7bGPJNk/J0QNjkLt4vC1iqWhc.",
        role: "admin",
        firstName: "System",
        lastName: "Admin",
        isActive: true,
      });
      console.log(`✅ Admin created: ${adminEmail} / admin123`);
    } else {
      console.log("ℹ️ Admin already exists.");
    }
  } catch (error) {
    console.error("❌ Error seeding database:", error);
  } finally {
    await client.end();
    console.log("✅ Seed complete");
  }
};

run().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
