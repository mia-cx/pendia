import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, instant, owned } from "./common.ts";
import { libraries } from "./core.ts";

export const permissions = [
  "view",
  "play",
  "manage-libraries",
  "manage-metadata",
  "manage-subtitles",
  "manage-users",
  "manage-plugins",
  "manage-transcoding",
  "manage-server",
] as const;
export type Permission = (typeof permissions)[number];
const permissionList = sql.raw(
  `ARRAY[${permissions.map((permission) => `'${permission}'`).join(",")}]::text[]`,
);

// Credentials store SHA-256 digests, never the raw token.
const tokenHash = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
const tokenHashBytes = sql`32`;

export const users = pgTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash"),
    oidcIssuer: text("oidc_issuer"),
    oidcSubject: text("oidc_subject"),
    disabledAt: instant("disabled_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "users_oidc_pair_check",
      sql`(${table.oidcIssuer} is null) = (${table.oidcSubject} is null)`,
    ),
    check(
      "users_identity_check",
      sql`${table.passwordHash} is not null or (${table.oidcIssuer} is not null and ${table.oidcSubject} is not null)`,
    ),
    uniqueIndex("users_username_unique").on(sql`lower(${table.username})`),
    uniqueIndex("users_email_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} is not null`),
    unique("users_oidc_unique").on(table.oidcIssuer, table.oidcSubject),
  ],
);

export const groups = pgTable(
  "groups",
  {
    id: id(),
    name: text("name").notNull().unique(),
    builtIn: boolean("built_in").notNull().default(false),
    permissions: text("permissions")
      .array()
      .$type<Permission[]>()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => [
    check(
      "groups_permissions_check",
      sql`${table.permissions} <@ ${permissionList}`,
    ),
  ],
);

export const userGroups = pgTable(
  "user_groups",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, owned),
  },
  (table) => [
    unique("user_groups_membership_unique").on(table.userId, table.groupId),
    index("user_groups_group_idx").on(table.groupId),
  ],
);

export const userPermissionOverrides = pgTable(
  "user_permission_overrides",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    permission: text("permission").$type<Permission>().notNull(),
    allowed: boolean("allowed").notNull(),
  },
  (table) => [
    unique("user_permission_overrides_unique").on(
      table.userId,
      table.permission,
    ),
    check(
      "user_permission_overrides_permission_check",
      sql`${table.permission} = ANY(${permissionList})`,
    ),
  ],
);

export const userSettings = pgTable(
  "user_settings",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => users.id, owned),
    bitrateCapBps: bigint("bitrate_cap_bps", { mode: "bigint" }),
    contentRatingCeiling: text("content_rating_ceiling"),
  },
  (table) => [
    check("user_settings_bitrate_check", sql`${table.bitrateCapBps} > 0`),
  ],
);

export const libraryAccess = pgTable(
  "library_access",
  {
    id: id(),
    libraryId: uuid("library_id")
      .notNull()
      .references(() => libraries.id, owned),
    userId: uuid("user_id").references(() => users.id, owned),
    groupId: uuid("group_id").references(() => groups.id, owned),
    allowed: boolean("allowed").notNull(),
  },
  (table) => [
    check(
      "library_access_principal_check",
      sql`num_nonnulls(${table.userId}, ${table.groupId}) = 1`,
    ),
    uniqueIndex("library_access_user_unique")
      .on(table.userId, table.libraryId)
      .where(sql`${table.userId} is not null`),
    uniqueIndex("library_access_group_unique")
      .on(table.groupId, table.libraryId)
      .where(sql`${table.groupId} is not null`),
    index("library_access_library_idx").on(table.libraryId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    clientName: text("client_name").notNull(),
    deviceId: text("device_id").notNull(),
    deviceName: text("device_name").notNull(),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastSeenAt: instant("last_seen_at").notNull().defaultNow(),
    expiresAt: instant("expires_at"),
    revokedAt: instant("revoked_at"),
  },
  (table) => [
    check(
      "sessions_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
    index("sessions_user_seen_idx").on(table.userId, table.lastSeenAt.desc()),
  ],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, owned),
    name: text("name").notNull(),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastUsedAt: instant("last_used_at"),
    expiresAt: instant("expires_at"),
    revokedAt: instant("revoked_at"),
  },
  (table) => [
    check(
      "api_keys_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
    index("api_keys_user_idx").on(table.userId),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    email: text("email").notNull(),
    tokenHash: tokenHash("token_hash").notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, {
      onDelete: "set null",
      onUpdate: "no action",
    }),
    expiresAt: instant("expires_at").notNull(),
    acceptedAt: instant("accepted_at"),
  },
  (table) => [
    check(
      "invites_token_hash_check",
      sql`octet_length(${table.tokenHash}) = ${tokenHashBytes}`,
    ),
  ],
);
