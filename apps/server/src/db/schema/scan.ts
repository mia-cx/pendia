import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProbeResult } from "../../mediums/video-common/probe.ts";
import { id, owned } from "./common.ts";
import { libraries } from "./core.ts";

/** Cached ffprobe results keyed by library and library-relative path. */
export const probeCache = pgTable(
  "probe_cache",
  {
    id: id(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, owned),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedNs: bigint("modified_ns", { mode: "bigint" }).notNull(),
    result: jsonb("result").$type<ProbeResult>().notNull(),
  },
  (table) => [
    unique("probe_cache_library_path_unique").on(table.libraryId, table.path),
    check("probe_cache_bytes_check", sql`${table.bytes} >= 0`),
  ],
);
