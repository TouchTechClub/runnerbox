import { drizzle } from "drizzle-orm/d1";

import type { DatabaseConfig } from "./config";
import { relations } from "./relations";
import * as schema from "./schema";

export { schema };

export function createDb(env: DatabaseConfig) {
  return drizzle(env.DB, { relations });
}

export type Database = ReturnType<typeof createDb>;
