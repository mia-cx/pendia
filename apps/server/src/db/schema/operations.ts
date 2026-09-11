import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./access.ts";
import {
  id,
  instant,
  type JsonObject,
  type JsonValue,
  owned,
} from "./common.ts";
import { items, versions } from "./core.ts";

export const settings = pgTable("settings", {
  id: id(),
  key: text("key").notNull().unique(),
  value: jsonb("value").$type<JsonValue>().notNull(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

// Plugin approval and enabled state belong to settings keyed by plugin name.
export const pluginLockfile = pgTable("plugin_lockfile", {
  id: id(),
  name: text("name").notNull().unique(),
  version: text("version").notNull(),
  source: text("source").notNull(),
  integrity: text("integrity").notNull(),
});

export type JobPayload =
  | { type: "scan"; libraryId: string; path: string }
  | { type: "probe"; fileId: string }
  | { type: "provider-fetch"; itemId: string; provider: string }
  | { type: "store"; sourceFileId: string; rung: string }
  | { type: "plugin"; pluginName: string; jobId: string; data: JsonObject };

export const jobType = pgEnum("job_type", [
  "scan",
  "probe",
  "provider-fetch",
  "store",
  "plugin",
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
    state: jobState("state").notNull().default("queued"),
    error: text("error"),
  },
  (table) => [
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
  ],
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
