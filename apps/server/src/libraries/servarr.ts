/** A filesystem change reported by a library writer. */
export type ChangeEvent =
  | { kind: "add"; path: string; providerIds: Record<string, string> }
  | {
      kind: "move";
      path: string;
      previousPath: string;
      providerIds: Record<string, string>;
    }
  | {
      kind: "delete";
      path: string;
      target: "file" | "item";
      providerIds: Record<string, string>;
    };

type PayloadShape = {
  message: string;
  itemKey: string;
  itemPathKey: string;
  fileKey: string;
  renamedKey: string;
  fileDeleteEvent: string;
  itemDeleteEvent: string;
  providerIds: readonly (readonly [string, string])[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const providerIdsOf = (
  source: Record<string, unknown>,
  fields: readonly (readonly [string, string])[],
): Record<string, string> => {
  const providerIds: Record<string, string> = {};
  for (const [field, name] of fields) {
    const value = source[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      providerIds[name] = String(value);
    } else if (typeof value === "string" && value !== "") {
      providerIds[name] = value;
    }
  }
  return providerIds;
};

const translateChanges = (
  payload: unknown,
  shape: PayloadShape,
): ChangeEvent[] => {
  if (!isObject(payload)) {
    return [];
  }
  const requireObject = (value: unknown): Record<string, unknown> => {
    if (!isObject(value)) {
      throw new Error(shape.message);
    }
    return value;
  };
  const requirePath = (value: unknown): string => {
    if (typeof value !== "string" || value === "") {
      throw new Error(shape.message);
    }
    return value;
  };
  const itemProviderIds = (): Record<string, string> =>
    providerIdsOf(requireObject(payload[shape.itemKey]), shape.providerIds);
  switch (payload.eventType) {
    case "Download": {
      const providerIds = itemProviderIds();
      const file = requireObject(payload[shape.fileKey]);
      const events: ChangeEvent[] = [
        { kind: "add", path: requirePath(file.path), providerIds },
      ];
      const deleted = payload.deletedFiles;
      if (deleted !== undefined && deleted !== null) {
        if (!Array.isArray(deleted)) {
          throw new Error(shape.message);
        }
        for (const entry of deleted) {
          events.push({
            kind: "delete",
            path: requirePath(requireObject(entry).path),
            target: "file",
            providerIds,
          });
        }
      }
      return events;
    }
    case "Rename": {
      const providerIds = itemProviderIds();
      const renamed = payload[shape.renamedKey];
      if (!Array.isArray(renamed)) {
        throw new Error(shape.message);
      }
      return renamed.map((entry): ChangeEvent => {
        const file = requireObject(entry);
        return {
          kind: "move",
          path: requirePath(file.path),
          previousPath: requirePath(file.previousPath),
          providerIds,
        };
      });
    }
    default: {
      if (payload.eventType === shape.fileDeleteEvent) {
        const providerIds = itemProviderIds();
        const file = requireObject(payload[shape.fileKey]);
        return [
          {
            kind: "delete",
            path: requirePath(file.path),
            target: "file",
            providerIds,
          },
        ];
      }
      if (payload.eventType === shape.itemDeleteEvent) {
        if (typeof payload.deletedFiles !== "boolean") {
          throw new Error(shape.message);
        }
        if (!payload.deletedFiles) return [];
        const item = requireObject(payload[shape.itemKey]);
        return [
          {
            kind: "delete",
            path: requirePath(item[shape.itemPathKey]),
            target: "item",
            providerIds: providerIdsOf(item, shape.providerIds),
          },
        ];
      }
      return [];
    }
  }
};

const sonarrShape: PayloadShape = {
  message: "Invalid Sonarr webhook payload.",
  itemKey: "series",
  itemPathKey: "path",
  fileKey: "episodeFile",
  renamedKey: "renamedEpisodeFiles",
  fileDeleteEvent: "EpisodeFileDelete",
  itemDeleteEvent: "SeriesDelete",
  providerIds: [
    ["tvdbId", "tvdb"],
    ["tmdbId", "tmdb"],
    ["imdbId", "imdb"],
  ],
};

const radarrShape: PayloadShape = {
  message: "Invalid Radarr webhook payload.",
  itemKey: "movie",
  itemPathKey: "folderPath",
  fileKey: "movieFile",
  renamedKey: "renamedMovieFiles",
  fileDeleteEvent: "MovieFileDelete",
  itemDeleteEvent: "MovieDelete",
  providerIds: [
    ["tmdbId", "tmdb"],
    ["imdbId", "imdb"],
  ],
};

/** Translates one Sonarr webhook payload into filesystem changes. */
export function sonarrChanges(payload: unknown): ChangeEvent[] {
  return translateChanges(payload, sonarrShape);
}

/** Translates one Radarr webhook payload into filesystem changes. */
export function radarrChanges(payload: unknown): ChangeEvent[] {
  return translateChanges(payload, radarrShape);
}
