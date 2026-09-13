/** The segments a live session has in scratch and the ffmpeg run producing more. */
export type LiveState = {
  ready: ReadonlySet<number>;
  run: {
    startIndex: number;
    // The highest index this run has finished; startIndex - 1 when none yet.
    frontier: number;
  } | null;
};

/** What to do for a segment request: serve it, wait for the running ffmpeg, or restart at it. */
export type SegmentDecision =
  | { action: "serve" }
  | { action: "wait" }
  | { action: "restart"; index: number };

/** The empty state of a new session. */
export const initialState: LiveState = { ready: new Set(), run: null };

/** Decides how to answer a request for one segment. */
export function decideSegment(
  state: LiveState,
  index: number,
  count: number,
): SegmentDecision {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError("Segment index out of range.");
  }
  if (state.ready.has(index)) {
    return { action: "serve" };
  }
  if (state.run !== null && index === state.run.frontier + 1) {
    return { action: "wait" };
  }
  return { action: "restart", index };
}

/** Records a started ffmpeg run at a segment index. */
export function runStarted(state: LiveState, startIndex: number): LiveState {
  return {
    ready: state.ready,
    run: { startIndex, frontier: startIndex - 1 },
  };
}

/** Records segments a run finished; the frontier advances to the highest unless the event is stale. */
export function segmentsReady(
  state: LiveState,
  indexes: readonly number[],
  advanceFrontier = true,
): LiveState {
  const ready = new Set(state.ready);
  for (const index of indexes) {
    ready.add(index);
  }
  return {
    ready,
    run:
      state.run === null
        ? null
        : {
            startIndex: state.run.startIndex,
            frontier: advanceFrontier
              ? Math.max(state.run.frontier, ...indexes)
              : state.run.frontier,
          },
  };
}

/** Records the run's end; a clean exit means every segment from its start is complete. */
export function runEnded(
  state: LiveState,
  clean: boolean,
  count: number,
): LiveState {
  if (!clean || state.run === null) {
    return { ready: state.ready, run: null };
  }
  const ready = new Set(state.ready);
  for (let index = state.run.startIndex; index < count; index += 1) {
    ready.add(index);
  }
  return { ready, run: null };
}
