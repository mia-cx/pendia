import { isAbsolute } from "node:path";
import { locateIn, type RootedPath } from "../libraries/roots.ts";
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

/** Where the watcher reaches the api, and the local path of each watched root. */
export type WatcherConfig = {
  apiUrl: URL;
  token: string;
  /** Root id to its absolute local path. */
  roots: Map<string, string>;
};

/** Timing and error options for a running watcher. */
export type WatcherOptions = {
  /** How often an idle watcher asks for a scan; also its heartbeat, which must stay under the job lease. */
  pollIntervalMs?: number;
  settleMs?: number;
  onError?: (error: unknown) => void;
};

type Job = NonNullable<WatcherClaim["job"]>;

/** Report answers after which the api has failed or finished the job itself. */
const settledStatuses = [400, 404, 409];

/** Reads PENDIA_API_URL, PENDIA_WATCHER_TOKEN and PENDIA_WATCH (`<root-id>=<path>,...`). */
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
    const [rootId, path] = pair.trim().split(/=(.*)/s, 2);
    if (!rootId || !path || !isAbsolute(path))
      throw new Error(
        "PENDIA_WATCH must list <root-id>=<absolute path> pairs, separated by commas.",
      );
    roots.set(rootId, path);
  }
  return {
    apiUrl: new URL(PENDIA_API_URL),
    token: PENDIA_WATCHER_TOKEN,
    roots,
  };
}

const encodeFile = (file: LibraryFile & { rootId: string }) => ({
  rootId: file.rootId,
  path: file.path,
  bytes: String(file.bytes),
  modifiedNs: String(file.modifiedNs),
});

const cacheKey = (file: ReturnType<typeof encodeFile>) =>
  `${file.bytes}:${file.modifiedNs}:${file.rootId}:${file.path}`;

/** Walks and probes one claimed scan in each root of its Library on local disk, skipping files with a current cached probe. */
async function runScan(
  roots: ReadonlyMap<string, string>,
  job: Job,
): Promise<WatcherReport> {
  const { claimToken } = job;
  const pathOf = (rootId: string) => {
    const root = roots.get(rootId);
    if (root === undefined) throw new Error(`Root ${rootId} is not watched.`);
    return root;
  };
  try {
    const { rules, recursive } = scanScope(job.medium, job.path);
    const files: (LibraryFile & { rootId: string })[] = [];
    for (const rootId of job.rootIds) {
      try {
        for await (const file of walkLibrary(pathOf(rootId), rules, {
          path: job.path,
          recursive,
        }))
          files.push({ ...file, rootId });
      } catch (error) {
        if (
          !(error instanceof MissingLibraryPathError) ||
          error.scope !== "requested"
        )
          throw error;
      }
    }
    const cached = new Set(job.cached.map(cacheKey));
    const probes: Extract<
      WatcherReport,
      { probes: unknown }
    >["probes"][number][] = [];
    // A Library scan only lists files; its directory scans probe them.
    for (const file of job.path === "." ? [] : files) {
      if (cached.has(cacheKey(encodeFile(file)))) continue;
      const { absolute } = await locateIn(pathOf(file.rootId), file.path);
      const ffprobe = await readFfprobe(absolute);
      const { keyframesSeconds } = await readKeyframeIndex(absolute);
      const after = await readLibraryFile(pathOf(file.rootId), file.path);
      if (after.bytes !== file.bytes || after.modifiedNs !== file.modifiedNs)
        throw new Error(`File changed during probe: ${file.path}`);
      probes.push({
        rootId: file.rootId,
        path: file.path,
        ffprobe,
        keyframesSeconds,
      });
    }
    const missing: RootedPath[] = [];
    for (const checked of job.check) {
      try {
        await readLibraryFile(pathOf(checked.rootId), checked.path);
      } catch (error) {
        if (!(error instanceof MissingLibraryPathError)) throw error;
        missing.push(checked);
      }
    }
    return { claimToken, files: files.map(encodeFile), probes, missing };
  } catch (error) {
    return {
      claimToken,
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
  const rootIds = [...roots.keys()];
  const request = (path: string, body: unknown) =>
    fetch(new URL(`/api/watcher/${path}`, apiUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  async function post(path: string, body: unknown) {
    const response = await request(path, body);
    if (!response.ok)
      throw new Error(
        `Watcher ${path} failed (${response.status}): ${await response.text()}`,
      );
    return response;
  }

  // Changes queue per root while one batch is in flight, then go as the next batch.
  const pending = new Map<string, WatchedChange[]>();
  let sending: Promise<void> | undefined;
  async function send() {
    // Map iteration also visits roots that queue again during a post.
    for (const [rootId, changes] of pending) {
      pending.delete(rootId);
      await post("events", { rootId, changes }).catch(onError);
    }
    sending = undefined;
  }
  const push = (rootId: string, changes: WatchedChange[]) => {
    pending.set(rootId, [...(pending.get(rootId) ?? []), ...changes]);
    sending ??= send();
  };

  const trees = await Promise.all(
    [...roots].map(([rootId, root]) =>
      watchTree(root, (changes) => push(rootId, changes), {
        settleMs,
        onError,
      }),
    ),
  );

  let stopped = false;
  let wake = () => {};
  /** Waits one poll interval, or until stop. */
  const nap = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /**
   * Posts a scan report until the api settles the job. The claimed job
   * holds its Library's concurrency key, so a lost report would block
   * every later scan. A 400, 404 or 409 means the api settled the job,
   * possibly from an earlier copy of this report whose answer never
   * arrived. Anything else, a 401 or 403 included, is retried.
   */
  async function deliver(jobId: string, report: WatcherReport) {
    for (;;) {
      try {
        const response = await request(`jobs/${jobId}`, report);
        if (response.ok || settledStatuses.includes(response.status)) {
          if (!response.ok)
            onError(
              new Error(
                `Watcher report for ${jobId} answered ${response.status}: ${await response.text()}`,
              ),
            );
          return;
        }
        onError(
          new Error(`Watcher report for ${jobId} failed (${response.status}).`),
        );
      } catch (error) {
        onError(error);
      }
      if (stopped) return;
      await nap();
    }
  }

  async function loop() {
    while (!stopped) {
      try {
        const { job }: WatcherClaim = await (
          await post("claim", { rootIds })
        ).json();
        if (job !== null) {
          // Also renews the job's lease; a 409 means another claim took the job.
          const held = { id: job.id, claimToken: job.claimToken };
          const heartbeat = setInterval(
            () => void post("heartbeat", { rootIds, job: held }).catch(onError),
            pollIntervalMs,
          );
          try {
            await deliver(job.id, await runScan(roots, job));
          } finally {
            clearInterval(heartbeat);
          }
          continue;
        }
      } catch (error) {
        onError(error);
      }
      if (stopped) break;
      await nap();
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
