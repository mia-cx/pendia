import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  type PgTableExtraConfigValue,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, instant, type JsonObject, owned } from "./common.ts";

export const medium = pgEnum("medium", ["movies", "shows"]);
export const itemKind = pgEnum("item_kind", [
  "movie",
  "show",
  "season",
  "episode",
]);
export const format = pgEnum("format", ["video", "audio", "ebook", "image"]);
export const versionOrigin = pgEnum("version_origin", ["imported", "stored"]);
export const streamKind = pgEnum("stream_kind", ["video", "audio", "subtitle"]);
export const artworkBackend = pgEnum("artwork_backend", [
  "colocated",
  "configured-path",
  "s3",
]);
export const metadataState = pgEnum("metadata_state", [
  "pending",
  "matched",
  "unmatched",
]);

export const libraries = pgTable("libraries", {
  id: id(),
  name: text("name").notNull(),
  medium: medium("medium").notNull(),
  rootPath: text("root_path").notNull(),
  configuration: jsonb("configuration")
    .$type<JsonObject>()
    .notNull()
    .default({}),
});

export const items = pgTable(
  "items",
  {
    id: id(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, owned),
    kind: itemKind("kind").notNull(),
    parentId: uuid("parent_id"),
    title: text("title").notNull(),
    year: integer("year"),
    overview: text("overview"),
    contentRating: text("content_rating"),
    genres: text("genres").array().notNull().default(sql`'{}'::text[]`),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    metadataState: metadataState("metadata_state").notNull().default("pending"),
    canonicalFolder: text("canonical_folder").notNull(),
    addedAt: instant("added_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("items_id_library_unique").on(table.id, table.libraryId),
    unique("items_id_kind_unique").on(table.id, table.kind),
    foreignKey({
      name: "items_parent_fk",
      columns: [table.parentId, table.libraryId],
      foreignColumns: [table.id, table.libraryId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    check("items_not_self_parent", sql`${table.parentId} <> ${table.id}`),
    index("items_added_idx").on(table.addedAt.desc(), table.id.desc()),
    index("items_library_added_idx").on(
      table.libraryId,
      table.addedAt.desc(),
      table.id.desc(),
    ),
    index("items_kind_added_idx").on(
      table.kind,
      table.addedAt.desc(),
      table.id.desc(),
    ),
    index("items_parent_added_idx").on(
      table.parentId,
      table.addedAt.desc(),
      table.id.desc(),
    ),
    index("items_folder_idx").on(table.libraryId, table.canonicalFolder),
  ],
);

export const itemAncestors = pgTable(
  "item_ancestors",
  {
    id: id(),
    ancestorId: uuid("ancestor_id")
      .notNull()
      .references(() => items.id, owned),
    descendantId: uuid("descendant_id")
      .notNull()
      .references(() => items.id, owned),
    depth: integer("depth").notNull(),
  },
  (table) => [
    unique("item_ancestors_pair_unique").on(
      table.ancestorId,
      table.descendantId,
    ),
    check(
      "item_ancestors_depth_check",
      sql`${table.depth} >= 0 and (${table.depth} = 0) = (${table.ancestorId} = ${table.descendantId})`,
    ),
    index("item_ancestors_descendant_idx").on(
      table.descendantId,
      table.depth,
      table.ancestorId,
    ),
  ],
);

export const segmentTimelines = pgTable(
  "segment_timelines",
  {
    id: id(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    cutKey: text("cut_key").notNull(),
    // A migration trigger keeps derived boundaries immutable.
    boundariesSeconds: doublePrecision("boundaries_seconds").array().notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("segment_timelines_cut_unique").on(table.itemId, table.cutKey),
    unique("segment_timelines_id_item_unique").on(table.id, table.itemId),
    // The migration defines this immutable array validator.
    check(
      "segment_timelines_boundaries_check",
      sql`valid_segment_boundaries(${table.boundariesSeconds})`,
    ),
  ],
);

export const versions = pgTable(
  "versions",
  {
    id: id(),
    itemId: uuid("item_id").notNull(),
    itemKind: itemKind("item_kind").notNull(),
    libraryId: uuid("library_id").notNull(),
    label: text("label").notNull(),
    format: format("format").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    durationSeconds: doublePrecision("duration_seconds"),
    keyframesSeconds: doublePrecision("keyframes_seconds").array(),
    lazyIndexPending: boolean("lazy_index_pending").notNull().default(true),
    // Migration triggers preserve timeline agreement across stored and source writes.
    segmentTimelineId: uuid("segment_timeline_id"),
    timelineAligned: boolean("timeline_aligned").notNull().default(false),
    origin: versionOrigin("origin").notNull().default("imported"),
    sourceFileId: uuid("source_file_id"),
    storedFolder: text("stored_folder"),
    rung: text("rung"),
    complete: boolean("complete"),
  },
  (table): PgTableExtraConfigValue[] => [
    unique("versions_id_item_format_unique").on(
      table.id,
      table.itemId,
      table.format,
    ),
    unique("versions_id_item_unique").on(table.id, table.itemId),
    unique("versions_id_library_unique").on(table.id, table.libraryId),
    foreignKey({
      name: "versions_item_kind_fk",
      columns: [table.itemId, table.itemKind],
      foreignColumns: [items.id, items.kind],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    foreignKey({
      name: "versions_item_library_fk",
      columns: [table.itemId, table.libraryId],
      foreignColumns: [items.id, items.libraryId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    foreignKey({
      name: "versions_source_file_fk",
      columns: [table.sourceFileId, table.itemId],
      foreignColumns: [files.id, files.itemId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    check(
      "versions_item_kind_check",
      sql`${table.itemKind} in ('movie', 'episode')`,
    ),
    check("versions_format_check", sql`${table.format} = 'video'`),
    foreignKey({
      name: "versions_timeline_fk",
      columns: [table.segmentTimelineId, table.itemId],
      foreignColumns: [segmentTimelines.id, segmentTimelines.itemId],
    })
      .onDelete("no action")
      .onUpdate("no action"),
    check("versions_bytes_check", sql`${table.bytes} >= 0`),
    check(
      "versions_duration_check",
      sql`${table.durationSeconds} >= 0 and ${table.durationSeconds} < 'Infinity'::float8`,
    ),
    check(
      "versions_alignment_check",
      sql`not ${table.timelineAligned} or ${table.segmentTimelineId} is not null`,
    ),
    check(
      "versions_storage_check",
      sql`(${table.origin} = 'imported' and ${table.sourceFileId} is null and ${table.storedFolder} is null and ${table.rung} is null and ${table.complete} is null) or (${table.origin} = 'stored' and ${table.format} = 'video' and ${table.sourceFileId} is not null and ${table.storedFolder} is not null and ${table.rung} is not null and ${table.complete} is not null and ${table.segmentTimelineId} is not null and ${table.timelineAligned})`,
    ),
    index("versions_item_idx").on(table.itemId),
    index("versions_source_file_idx").on(table.sourceFileId),
    uniqueIndex("versions_source_file_rung_unique")
      .on(table.sourceFileId, table.rung)
      .where(sql`${table.origin} = 'stored'`),
  ],
);

export type Chapter = {
  title: string | null;
  startSeconds: number;
  endSeconds: number;
};

export const files = pgTable(
  "files",
  {
    id: id(),
    versionId: uuid("version_id").notNull(),
    itemId: uuid("item_id").notNull(),
    libraryId: uuid("library_id").notNull(),
    path: text("path").notNull(),
    order: integer("order").notNull(),
    bytes: bigint("bytes", { mode: "bigint" }).notNull(),
    modifiedAt: instant("modified_at").notNull(),
    container: text("container"),
    durationSeconds: doublePrecision("duration_seconds"),
    chapters: jsonb("chapters").$type<Chapter[]>().notNull().default([]),
  },
  (table) => [
    unique("files_version_order_unique").on(table.versionId, table.order),
    unique("files_library_path_unique").on(table.libraryId, table.path),
    unique("files_id_item_unique").on(table.id, table.itemId),
    unique("files_id_version_unique").on(table.id, table.versionId),
    foreignKey({
      name: "files_version_item_fk",
      columns: [table.versionId, table.itemId],
      foreignColumns: [versions.id, versions.itemId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    foreignKey({
      name: "files_version_library_fk",
      columns: [table.versionId, table.libraryId],
      foreignColumns: [versions.id, versions.libraryId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    check("files_bytes_check", sql`${table.bytes} >= 0`),
    check("files_order_check", sql`${table.order} >= 0`),
    check(
      "files_duration_check",
      sql`${table.durationSeconds} >= 0 and ${table.durationSeconds} < 'Infinity'::float8`,
    ),
    index("files_library_path_idx").on(table.libraryId, table.path),
  ],
);

export const streams = pgTable(
  "streams",
  {
    id: id(),
    versionId: uuid("version_id")
      .notNull()
      .references(() => versions.id, owned),
    // Migration triggers reserve fileless Streams for stored Versions.
    fileId: uuid("file_id"),
    index: integer("index").notNull(),
    kind: streamKind("kind").notNull(),
    codec: text("codec").notNull(),
    profile: text("profile"),
    level: integer("level"),
    language: text("language"),
    title: text("title"),
    bitrate: bigint("bitrate", { mode: "bigint" }),
    disposition: jsonb("disposition")
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    width: integer("width"),
    height: integer("height"),
    frameRateNumerator: integer("frame_rate_numerator"),
    frameRateDenominator: integer("frame_rate_denominator"),
    hdr: text("hdr"),
    dvProfile: integer("dv_profile"),
    channels: integer("channels"),
    channelLayout: text("channel_layout"),
    sampleRate: integer("sample_rate"),
  },
  (table) => [
    foreignKey({
      name: "streams_file_version_fk",
      columns: [table.fileId, table.versionId],
      foreignColumns: [files.id, files.versionId],
    })
      .onDelete("cascade")
      .onUpdate("no action"),
    uniqueIndex("streams_file_index_unique")
      .on(table.fileId, table.index)
      .where(sql`${table.fileId} is not null`),
    uniqueIndex("streams_version_index_unique")
      .on(table.versionId, table.index)
      .where(sql`${table.fileId} is null`),
    index("streams_version_idx").on(table.versionId),
    check("streams_index_check", sql`${table.index} >= 0`),
    check("streams_bitrate_check", sql`${table.bitrate} >= 0`),
    check("streams_level_check", sql`${table.level} >= 0`),
    check("streams_width_check", sql`${table.width} > 0`),
    check("streams_height_check", sql`${table.height} > 0`),
    check(
      "streams_frame_rate_check",
      sql`(${table.frameRateNumerator} is null and ${table.frameRateDenominator} is null) or (${table.frameRateNumerator} is not null and ${table.frameRateDenominator} is not null and ${table.frameRateNumerator} > 0 and ${table.frameRateDenominator} > 0)`,
    ),
    check("streams_dv_profile_check", sql`${table.dvProfile} >= 0`),
    check("streams_channels_check", sql`${table.channels} > 0`),
    check("streams_sample_rate_check", sql`${table.sampleRate} > 0`),
  ],
);

export const contributors = pgTable("contributors", {
  id: id(),
  name: text("name").notNull(),
  overview: text("overview"),
});

export const credits = pgTable(
  "credits",
  {
    id: id(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, owned),
    contributorId: uuid("contributor_id")
      .notNull()
      .references(() => contributors.id, owned),
    role: text("role").notNull(),
    character: text("character"),
    order: integer("order").notNull(),
  },
  (table) => [
    check("credits_order_check", sql`${table.order} >= 0`),
    index("credits_item_idx").on(
      table.itemId,
      table.role,
      table.order,
      table.id,
    ),
    index("credits_contributor_idx").on(
      table.contributorId,
      table.role,
      table.itemId,
    ),
  ],
);

export const providerIds = pgTable(
  "provider_ids",
  {
    id: id(),
    provider: text("provider").notNull(),
    value: text("value").notNull(),
    itemId: uuid("item_id").references(() => items.id, owned),
    contributorId: uuid("contributor_id").references(
      () => contributors.id,
      owned,
    ),
  },
  (table) => [
    check(
      "provider_ids_owner_check",
      sql`num_nonnulls(${table.itemId}, ${table.contributorId}) = 1`,
    ),
    uniqueIndex("provider_ids_item_unique")
      .on(table.itemId, table.provider)
      .where(sql`${table.itemId} is not null`),
    uniqueIndex("provider_ids_contributor_unique")
      .on(table.contributorId, table.provider)
      .where(sql`${table.contributorId} is not null`),
    index("provider_ids_lookup_idx").on(table.provider, table.value),
  ],
);

export const artwork = pgTable(
  "artwork",
  {
    id: id(),
    itemId: uuid("item_id").references(() => items.id, owned),
    versionId: uuid("version_id").references(() => versions.id, owned),
    type: text("type").notNull(),
    sourceUrl: text("source_url"),
    backend: artworkBackend("backend").notNull(),
    storageKey: text("storage_key").notNull(),
    width: integer("width"),
    height: integer("height"),
    selected: boolean("selected").notNull().default(false),
  },
  (table) => [
    check(
      "artwork_owner_check",
      sql`num_nonnulls(${table.itemId}, ${table.versionId}) = 1`,
    ),
    check("artwork_width_check", sql`${table.width} > 0`),
    check("artwork_height_check", sql`${table.height} > 0`),
    uniqueIndex("artwork_item_selected_unique")
      .on(table.itemId, table.type)
      .where(sql`${table.selected} and ${table.itemId} is not null`),
    uniqueIndex("artwork_version_selected_unique")
      .on(table.versionId, table.type)
      .where(sql`${table.selected} and ${table.versionId} is not null`),
    index("artwork_item_type_idx").on(table.itemId, table.type),
    index("artwork_version_type_idx").on(table.versionId, table.type),
  ],
);
