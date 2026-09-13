import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { files, segmentTimelines, versions } from "../db/schema/index.ts";
import { editionTag } from "../mediums/video-common/paths.ts";
import {
  deriveSegmentTimeline,
  isTimelineAligned,
} from "../playback/timeline.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Reuse each cut's first imported Version to establish immutable scan timelines. */
export async function persistScanTimelines(
  db: Transaction,
  itemId: string,
): Promise<void> {
  const rows = await db
    .select({ version: versions, path: files.path })
    .from(versions)
    .innerJoin(files, and(eq(files.versionId, versions.id), eq(files.order, 0)))
    .where(and(eq(versions.itemId, itemId), eq(versions.origin, "imported")))
    .orderBy(asc(versions.id));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const cutKey = editionTag(row.path)?.toLowerCase() ?? "original";
    const group = groups.get(cutKey) ?? [];
    group.push(row);
    groups.set(cutKey, group);
  }
  const timelines = new Map(
    (
      await db
        .select()
        .from(segmentTimelines)
        .where(eq(segmentTimelines.itemId, itemId))
    ).map((timeline) => [timeline.cutKey, timeline]),
  );
  for (const [cutKey, group] of groups) {
    const source = group[0]?.version;
    let timeline = timelines.get(cutKey);
    if (
      timeline === undefined &&
      source !== undefined &&
      source.durationSeconds !== null &&
      source.keyframesSeconds !== null &&
      isTimelineAligned(
        [0, source.durationSeconds],
        source.keyframesSeconds,
        source.durationSeconds,
      )
    ) {
      const [inserted] = await db
        .insert(segmentTimelines)
        .values({
          itemId,
          cutKey,
          boundariesSeconds: deriveSegmentTimeline(
            source.keyframesSeconds,
            source.durationSeconds,
          ),
        })
        .returning();
      if (!inserted) throw new Error("Timeline insertion returned no row.");
      timeline = inserted;
    }
    for (const { version } of group) {
      await db
        .update(versions)
        .set({
          segmentTimelineId: timeline?.id ?? null,
          timelineAligned:
            timeline !== undefined &&
            version.durationSeconds !== null &&
            version.keyframesSeconds !== null &&
            isTimelineAligned(
              timeline.boundariesSeconds,
              version.keyframesSeconds,
              version.durationSeconds,
            ),
        })
        .where(eq(versions.id, version.id));
    }
  }
}
