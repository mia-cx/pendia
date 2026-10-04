import { isAbsolute, join } from "node:path";
import { scanScope } from "../libraries/scan.ts";
import {
  type LibraryFile,
  MissingLibraryPathError,
  readLibraryFile,
  walkLibrary,
} from "../libraries/walker.ts";
import type { WatchedChange } from "../libraries/webhooks.ts";
import { readKeyframeIndex } from "../mediums/video-common/keyframes.ts";
import { readFfprobe } from "../mediums/video-common/probe.ts";
import type { WatcherClaim, WatcherReport } from "./http.ts";
import { watchTree } from "./tree.ts";

/** Where the watcher reaches the api, and the local root of each watched Library. */
export type WatcherConfig = {
  apiUrl: URL;
  token: string;
  /** Library id to the absolute local path of its root. */
  roots: Map<string, string>;
};

/** Timing and error options for a running watcher. */
export type WatcherOptions = {
  /** How often an idle watcher asks for a scan; also its heartbeat. */
  pollIntervalMs?: number;
  settleMs?: number;
  onError?: (error: unknown) => void;
};

type Job = NonNullable<WatcherClaim["job"]>;

/** Reads PENDIA_API_URL, PENDIA_WATCHER_TOKEN and PENDIA_WATCH (`<library-id>=<path>,...`). */
export function readWatcherConfig(
  env: Record<string, string | undefined>,
): WatcherConfig {
  const { PENDIA_API_URL, PENDIA_WATCHER_TOKEN, PENDIA_WATCH } = env;
  if (!PENDIA_API_URL || !URL.canParse(PENDIA_API_URL))
    throw new Error("PENDIA_API_URL must be the api's URL.");
  if (!PENDIA_WATCHER_TOKEN)
    throw new Error("PENDIA_WATCHER_TOKEN must be an API key.");
  const roots = new Map<string, string>();
  for (const pair of (PENDIA_WATCH ?? "").split(",")) {
    const [libraryId, path] = pair.trim().split(/=(.*)/s, 2);
    if (!libraryId || !path || !isAbsolute(path))
      throw new Error(
        "PENDIA_WATCH must list <library-id>=<absolute path> pairs, separated by commas.",
      );
    roots.set(libraryId, path);
  }
  return {
    apiUrl: new URL(PENDIA_API_URL),
    token: PENDIA_WATCHER_TOKEN,
    roots,
  };
}

const encodeFile = (file: LibraryFile) => ({
  path: file.path,
  bytes: String(file.bytes),
  modifiedNs: String(file.modifiedNs),
});

const cacheKey = (file: ReturnType<typeof encodeFile>) =>
  `${file.bytes}:${file.modifiedNs}:${file.path}`;

/** Walks and probes one claimed scan on local disk, skipping files with a current cached probe. */
async function runScan(root: string, job: Job): Promise<WatcherReport> {
  const { attempts } = job;
  try {
    const { rules, recursive } = scanScope(job.medium, job.path);
    const files: LibraryFile[] = [];
    try {
      for await (const file of walkLibrary(root, rules, {
        path: job.path,
        recursive,
      }))
        files.push(file);
    } catch (error) {
      if (
        !(error instanceof MissingLibraryPathError) ||
        error.scope !== "requested"
      )
        throw error;
    }
    const cached = new Set(job.cached.map(cacheKey));
    const probes: Extract<
      WatcherReport,
      { probes: unknown }
    >["probes"][number][] = [];
    // A Library scan only lists files; its directory scans probe them.
    for (const file of job.path === "." ? [] : files) {
      if (cached.has(cacheKey(encodeFile(file)))) continue;
      const absolute = join(root, file.path);
      const ffprobe = await readFfprobe(absolute);
      const { keyframesSeconds } = await readKeyframeIndex(absolute);
      const after = await readLibraryFile(root, file.path);
      if (after.bytes !== file.bytes || after.modifiedNs !== file.modifiedNs)
        throw new Error(`File changed during probe: ${file.path}`);
      probes.push({ path: file.path, ffprobe, keyframesSeconds });
    }
    return { attempts, files: files.map(encodeFile), probes };
  } catch (error) {
    return {
      attempts,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Starts the watcher role: pushes file changes to the api and runs its Libraries' scans locally. */
export async function startWatcher(
  { apiUrl, token, roots }: WatcherConfig,
  {
    pollIntervalMs = 5_000,
    settleMs = 200,
    onError = console.error,
  }: WatcherOptions = {},
) {
  const libraryIds = [...roots.keys()];
  async function post(path: string, body: unknown) {
    const response = await fetch(new URL(`/api/watcher/${path}`, apiUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        `Watcher ${path} failed (${response.status}): ${await response.text()}`,
      );
    return response;
  }

  // Changes queue per Library while one batch is in flight, then go as the next batch.
  const pending = new Map<string, WatchedChange[]>();
  let sending: Promise<void> | undefined;
  async function send() {
    // Map iteration also visits Libraries that queue again during a post.
    for (const [libraryId, changes] of pending) {
      pending.delete(libraryId);
      await post("events", { libraryId, changes }).catch(onError);
    }
    sending = undefined;
  }
  const push = (libraryId: string, changes: WatchedChange[]) => {
    pending.set(libraryId, [...(pending.get(libraryId) ?? []), ...changes]);
    sending ??= send();
  };

  const trees = await Promise.all(
    [...roots].map(([libraryId, root]) =>
      watchTree(root, (changes) => push(libraryId, changes), {
        settleMs,
        onError,
      }),
    ),
  );

  let stopped = false;
  let wake = () => {};
  async function loop() {
    while (!stopped) {
      try {
        const { job }: WatcherClaim = await (
          await post("claim", { libraryIds })
        ).json();
        if (job !== null) {
          const root = roots.get(job.libraryId);
          if (root === undefined) throw new Error("Claimed an unwatched scan.");
          const heartbeat = setInterval(
            () => void post("heartbeat", { libraryIds }).catch(onError),
            pollIntervalMs,
          );
          try {
            await post(`jobs/${job.id}`, await runScan(root, job));
          } finally {
            clearInterval(heartbeat);
          }
          continue;
        }
      } catch (error) {
        onError(error);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollIntervalMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
  const running = loop();

  let stopping: Promise<void> | undefined;
  return {
    /** Stops watching, finishes the running scan and sends the last changes. */
    stop() {
      stopping ??= (async () => {
        stopped = true;
        for (const tree of trees) tree.close();
        wake();
        await running;
        await sending;
      })();
      return stopping;
    },
  };
}
