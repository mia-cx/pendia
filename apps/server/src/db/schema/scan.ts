import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProbeResult } from "../../mediums/video-common/probe.ts";
import { id, jsonb, owned } from "./common.ts";
import { libraryRoots } from "./core.ts";

/** Cached ffprobe results keyed by root and root-relative path. */
export const probeCache = pgTable(
  "probe_cache",
  {
    id: id(),
    rootId: uuid("root_id")
      .notNull()
      .references(() => libraryRoots.id, owned),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedNs: bigint("modified_ns", { mode: "bigint" }).notNull(),
    result: jsonb("result").$type<ProbeResult>().notNull(),
  },
  (table) => [
    unique("probe_cache_root_path_unique").on(table.rootId, table.path),
    check("probe_cache_bytes_check", sql`${table.bytes} >= 0`),
  ],
);
