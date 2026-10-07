/** A volume boost for one media element; `amplify` sets the gain and `close` releases the graph and its AudioContext. */
export type Boost = {
  amplify: (gain: number) => void;
  close: () => void;
};

/**
 * Wires a media element through a Web Audio gain stage with a limiter on top:
 * source → gain → compressor → destination. The graph is built lazily on the
 * first boost above unity; gain 1 bypasses the compressor so no makeup gain
 * changes the level, and no graph at all exists before the first boost.
 */
export function createBoost(
  media: HTMLMediaElement,
  createContext: () => AudioContext = () => new AudioContext(),
): Boost {
  let context: AudioContext | undefined;
  let source: MediaElementAudioSourceNode | undefined;
  let gain: GainNode | undefined;
  let compressor: DynamicsCompressorNode | undefined;
  let closed = false;

  const resume = () => {
    if (context !== undefined && context.state !== "running")
      void context.resume().catch(() => {});
  };
  media.addEventListener("play", resume);

  return {
    amplify(level: number) {
      if (closed) return;
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
        source = context.createMediaElementSource(media);
        source.connect(gain);
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
    },
    close() {
      if (closed) return;
      closed = true;
      media.removeEventListener("play", resume);
      source?.disconnect();
      gain?.disconnect();
      compressor?.disconnect();
      if (context !== undefined && context.state !== "closed")
        void context.close().catch(() => {});
    },
  };
}
