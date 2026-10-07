import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProbeResult } from "../../mediums/video-common/probe.ts";
import { id, instant, jsonb, owned } from "./common.ts";
import { libraryRoots } from "./core.ts";

/** Why a scan skipped a file: ffprobe couldn't read it, or it holds no video stream. */
export const scanFailureReason = pgEnum("scan_failure_reason", [
  "unreadable",
  "no-video",
]);

/**
 * Files a scan skipped, keyed by root and root-relative path. The size and
 * mtime are the file's when it failed: a rescan probes it again only once
 * they change. A successful index of the path deletes the row.
 */
export const scanFailures = pgTable(
  "scan_failures",
  {
    id: id(),
    rootId: uuid("root_id")
      .notNull()
      .references(() => libraryRoots.id, owned),
    path: text("path").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedNs: bigint("modified_ns", { mode: "bigint" }).notNull(),
    reason: scanFailureReason("reason").notNull(),
    /** The full error text, such as ffprobe's stderr. */
    detail: text("detail").notNull(),
    failedAt: instant("failed_at").notNull().defaultNow(),
  },
  (table) => [
    unique("scan_failures_root_path_unique").on(table.rootId, table.path),
    check("scan_failures_bytes_check", sql`${table.bytes} >= 0`),
  ],
);

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
