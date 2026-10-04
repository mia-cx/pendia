import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { migrateDatabase } from "./migrate.ts";
import { databaseUrl, withDatabase } from "./testing.ts";

const video = {
  action: "transcode",
  codec: "h264",
  burnSubtitles: true,
  width: 640,
  height: 360,
};

// Decisions as sessions planned before Stream selection stored them.
const legacy = [
  {
    method: "transcode",
    video,
    audio: [
      { action: "transcode", codec: "aac", channels: 2 },
      { action: "copy", codec: "ac3", channels: 6 },
    ],
    subtitles: [
      { action: "convert", format: "webvtt", delivery: "sidecar" },
      { action: "burn", format: "pgs" },
    ],
  },
  { method: "remux", video, audio: [], subtitles: [] },
  { method: "stored", storedVariantIds: ["v"] },
];

describe.skipIf(!databaseUrl)("session decision migration", () => {
  test("the 0015 migration keeps what pre-selection sessions played", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        for (const decision of legacy)
          await tx.execute(
            sql`insert into session_registry (id, user_id, item_id, version_id, play_method, state, decision)
                values (uuidv7(), uuidv7(), uuidv7(), uuidv7(), 'remux', 'playing', ${JSON.stringify(decision)}::text::jsonb)`,
          );
      });
      const migration = await Bun.file(
        new URL(
          "../../drizzle/0015_session_decision_selection.sql",
          import.meta.url,
        ),
      ).text();
      for (const statement of migration.split("--> statement-breakpoint"))
        await db.execute(sql.raw(statement));

      const rows = await db.execute<{ decision: unknown }>(
        sql`select decision from session_registry order by id`,
      );
      expect(rows.map((row) => row.decision)).toEqual([
        {
          method: "transcode",
          video,
          audio: { action: "transcode", codec: "aac", channels: 2 },
          subtitles: [
            {
              stream: 0,
              action: "convert",
              format: "webvtt",
              delivery: "sidecar",
            },
            { stream: 1, action: "burn", format: "pgs" },
          ],
          selection: { audio: 0 },
        },
        {
          method: "remux",
          video,
          audio: null,
          subtitles: [],
          selection: { audio: null },
        },
        {
          method: "stored",
          storedVariantIds: ["v"],
          selection: { audio: 0 },
        },
      ]);
    }));
});
