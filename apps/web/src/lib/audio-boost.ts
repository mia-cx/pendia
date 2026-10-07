/**
 * Wires a media element through a Web Audio gain stage with a limiter on top:
 * source → gain → compressor → destination. The graph is built lazily on the
 * first boost above unity; gain 1 bypasses the compressor so no makeup gain
 * changes the level, and no graph at all exists before the first boost.
 */
export function createBoost(
  media: HTMLMediaElement,
  createContext: () => AudioContext = () => new AudioContext(),
) {
  let context: AudioContext | undefined;
  let gain: GainNode | undefined;
  let compressor: DynamicsCompressorNode | undefined;

  const resume = () => {
    if (context !== undefined && context.state !== "running")
      void context.resume().catch(() => {});
  };
  media.addEventListener("play", resume);

  return (level: number) => {
    // No graph exists for unity gain until a boost creates one.
    if (level <= 1 && gain === undefined) return;
    context ??= createContext();
    if (gain === undefined || compressor === undefined) {
      gain = context.createGain();
      compressor = context.createDynamicsCompressor();
      compressor.threshold.value = -3;
      compressor.knee.value = 0;
      compressor.ratio.value = 20;
      compressor.attack.value = 0.001;
      compressor.release.value = 0.25;
      context.createMediaElementSource(media).connect(gain);
    }
    gain.gain.value = level;
    gain.disconnect();
    compressor.disconnect();
    if (level > 1) {
      gain.connect(compressor);
      compressor.connect(context.destination);
    } else {
      gain.connect(context.destination);
    }
    resume();
  };
}
