import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../../database/schema.js";

export type MerchDb = PostgresJsDatabase<typeof schema>;
