/** The target segment length in seconds used when deriving boundaries. */
export const segmentTargetSeconds = 4;

function validKeyframes(keyframes: readonly number[], durationSeconds: number) {
  return (
    Number.isFinite(durationSeconds) &&
    durationSeconds > 0 &&
    keyframes[0] === 0 &&
    keyframes.every(
      (time, index) =>
        Number.isFinite(time) &&
        time >= 0 &&
        time <= durationSeconds &&
        (index === 0 || time > (keyframes[index - 1] ?? Infinity)),
    )
  );
}

/** Returns the segment boundaries for a Version, including zero and the duration. */
export function deriveSegmentTimeline(
  keyframesSeconds: readonly number[],
  durationSeconds: number,
) {
  if (!validKeyframes(keyframesSeconds, durationSeconds)) {
    throw new Error(
      "Keyframes must increase from zero within a positive finite duration.",
    );
  }
  const boundariesSeconds = [0];
  let previous = 0;
  let index = 1;
  while (previous + segmentTargetSeconds < durationSeconds) {
    let nearest = keyframesSeconds[index];
    if (nearest === undefined || nearest >= durationSeconds) break;
    const target = previous + segmentTargetSeconds;
    let next = keyframesSeconds[index + 1];
    while (
      next !== undefined &&
      next < durationSeconds &&
      Math.abs(next - target) < Math.abs(nearest - target)
    ) {
      index += 1;
      nearest = next;
      next = keyframesSeconds[index + 1];
    }
    boundariesSeconds.push(nearest);
    previous = nearest;
    index += 1;
  }
  boundariesSeconds.push(durationSeconds);
  return boundariesSeconds;
}

/** Returns whether foreign keyframes cover every boundary except the duration endpoint. */
export function isTimelineAligned(
  boundariesSeconds: readonly number[],
  keyframesSeconds: readonly number[],
  durationSeconds: number,
) {
  if (
    boundariesSeconds.length < 2 ||
    boundariesSeconds.at(-1) !== durationSeconds ||
    !validKeyframes(boundariesSeconds, durationSeconds) ||
    !validKeyframes(keyframesSeconds, durationSeconds)
  ) {
    return false;
  }
  const keyframes = new Set(keyframesSeconds);
  return boundariesSeconds
    .slice(0, -1)
    .every((boundary) => keyframes.has(boundary));
}
