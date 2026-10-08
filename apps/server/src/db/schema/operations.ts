import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import type { SessionDecision } from "../../playback/decisions.ts";
import { users } from "./access.ts";
import {
  id,
  instant,
  type JsonObject,
  type JsonValue,
  jsonb,
  owned,
} from "./common.ts";
import { items, versions } from "./core.ts";

export const settings = pgTable("settings", {
  id: id(),
  key: text("key").notNull().unique(),
  value: jsonb("value").$type<JsonValue>().notNull(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

/** The advisory lock class serialising read-modify-write of one settings row. */
export const settingsLockClass = 0x70656e64;

// Plugin approval and enabled state belong to settings keyed by plugin name.
export const pluginLockfile = pgTable("plugin_lockfile", {
  id: id(),
  name: text("name").notNull().unique(),
  version: text("version").notNull(),
  source: text("source").notNull(),
  integrity: text("integrity").notNull(),
});

/** A change inside one root of a Library, carried by a scan job. Paths are relative to the root; a move stays in its root. */
export type ScanChange =
  | {
      kind: "add";
      rootId: string;
      path: string;
      providerIds: Record<string, string>;
    }
  | {
      kind: "move";
      rootId: string;
      path: string;
      previousPath: string;
      providerIds: Record<string, string>;
    }
  | {
      kind: "delete";
      rootId: string;
      path: string;
      target: "file" | "item";
      providerIds: Record<string, string>;
    };

export type JobPayload =
  // A directory scan's runId is the id of the root job that fanned it out.
  | {
      type: "scan";
      libraryId: string;
      path: string;
      changes?: ScanChange[];
      reconcileMissing?: boolean;
      runId?: string;
      /** Folder jobs this whole-Library run created or reused. */
      childJobIds?: string[];
    }
  | { type: "probe"; fileId: string }
  // `weekly` marks the one refresh a continuing Show keeps queued a week ahead.
  | { type: "provider-fetch"; itemId: string; weekly?: true }
  // Fetches the configured subtitle languages an Item has no track for yet.
  | { type: "subtitle-fetch"; itemId: string }
  // A store job encodes one rung, or sweeps a library folder's stored output.
  | { type: "store"; sourceFileId: string; rung: string }
  | { type: "store"; libraryId: string; folder: string }
  | { type: "plugin"; pluginName: string; jobId: string; data: JsonObject }
  // Reads one scanned file's container keyframe index after its scan.
  | {
      type: "keyframe-index";
      libraryId: string;
      rootId: string;
      path: string;
    };

export const jobType = pgEnum("job_type", [
  "scan",
  "probe",
  "provider-fetch",
  "store",
  "plugin",
  "subtitle-fetch",
  "keyframe-index",
]);
export const jobState = pgEnum("job_state", [
  "queued",
  "running",
  "completed",
  "failed",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    type: jobType("type").notNull(),
    payload: jsonb("payload").$type<JobPayload>().notNull(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    runAfter: instant("run_after").notNull().defaultNow(),
    concurrencyKey: text("concurrency_key"),
    /** Set when the enqueue carried a dedupe option; unsettled jobs with the same key coalesce. */
    dedupeKey: text("dedupe_key"),
    state: jobState("state").notNull().default("queued"),
    error: text("error"),
    /** Written fresh by each claim; only its holder may renew, complete or fail the job. */
    claimToken: uuid("claim_token").notNull().defaultRandom(),
    /** A running job past this time is claimable again. */
    leaseExpiresAt: instant("lease_expires_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "jobs_payload_type_check",
      sql`(${table.payload}->>'type') is not null and ${table.payload}->>'type' = ${table.type}::text`,
    ),
    check(
      "jobs_attempts_check",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    index("jobs_queued_idx")
      .on(table.priority.desc(), table.runAfter, table.id)
      .where(sql`${table.state} = 'queued'`),
    index("jobs_running_idx")
      .on(table.concurrencyKey)
      .where(sql`${table.state} = 'running'`),
    index("jobs_lease_idx")
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'running'`),
    index("jobs_scan_library_idx")
      .on(sql`(${table.payload}->>'libraryId')`)
      .where(sql`${table.type} = 'scan'`),
    index("jobs_dedupe_idx").on(table.dedupeKey, table.state),
    index("jobs_scan_run_idx")
      .on(sql`(${table.payload}->>'runId')`)
      .where(sql`${table.type} = 'scan'`),
  ],
);

// Events are durable so a reconnecting client can replay what it missed.
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<JsonObject>().notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [index("events_created_idx").on(table.createdAt)],
);

export type TranscoderBackend = {
  name: string;
  codecs: string[];
  toneMapping: string[];
};

export const transcoderCapabilities = pgTable("transcoder_capabilities", {
  id: id(),
  name: text("name").notNull(),
  address: text("address").notNull(),
  testedAt: instant("tested_at").notNull(),
  backends: jsonb("backends").$type<TranscoderBackend[]>().notNull(),
});

export const playMethod = pgEnum("play_method", [
  "direct-play",
  "remux",
  "transcode",
]);
export const playbackState = pgEnum("playback_state", [
  "queued",
  "starting",
  "playing",
  "stopped",
]);

export const sessionRegistry = pgTable(
  "session_registry",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    versionId: uuid("version_id").notNull(),
    playMethod: playMethod("play_method").notNull(),
    state: playbackState("state").notNull(),
    transcoderNodeId: uuid("transcoder_node_id"),
    decision: jsonb("decision").$type<SessionDecision>(),
    // The app and device that planned the session; an API key has no device.
    clientName: text("client_name"),
    deviceName: text("device_name"),
    // The device session or API key that opened it, so a report that names no
    // session finds the reporting device's own. Either table, so no foreign key.
    credentialId: uuid("credential_id"),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "session_registry_node_fk",
      columns: [table.transcoderNodeId],
      foreignColumns: [transcoderCapabilities.id],
    })
      .onDelete("set null")
      .onUpdate("no action"),
    foreignKey({
      name: "session_registry_version_fk",
      columns: [table.versionId, table.itemId],
      foreignColumns: [versions.id, versions.itemId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    index("session_registry_node_state_idx").on(
      table.transcoderNodeId,
      table.state,
      table.createdAt,
      table.id,
    ),
    index("session_registry_seen_idx").on(table.lastSeenAt),
  ],
);
