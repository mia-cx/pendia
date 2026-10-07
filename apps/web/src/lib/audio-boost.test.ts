import { describe, expect, test } from "bun:test";
import { createBoost } from "./audio-boost.ts";

class FakeParam {
  value = 0;
}

class FakeNode {
  connected: FakeNode[] = [];
  connect(node: FakeNode) {
    this.connected.push(node);
    return node;
  }
  disconnect() {
    this.connected = [];
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

class FakeContext {
  state = "suspended";
  destination = new FakeNode();
  source = new FakeNode();
  gains: FakeGain[] = [];
  compressors: FakeCompressor[] = [];
  mediaSources = 0;
  resumes = 0;

  createMediaElementSource() {
    this.mediaSources += 1;
    return this.source;
  }
  createGain() {
    const node = new FakeGain();
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor() {
    const node = new FakeCompressor();
    this.compressors.push(node);
    return node;
  }
  resume() {
    this.resumes += 1;
    this.state = "running";
    return Promise.resolve();
  }
}

function setup() {
  const media = new EventTarget() as unknown as HTMLMediaElement;
  const context = new FakeContext();
  let created = 0;
  const amplify = createBoost(media, () => {
    created += 1;
    return context as unknown as AudioContext;
  });
  return { media, context, amplify, created: () => created };
}

describe("audio boost", () => {
  test("gain 1 first builds no graph at all", () => {
    const { context, amplify, created } = setup();
    amplify(1);
    expect(created()).toBe(0);
    expect(context.gains).toHaveLength(0);
  });

  test("the first boost builds the chain once through the limiter", () => {
    const { context, amplify } = setup();
    amplify(2);
    amplify(3);
    expect(context.mediaSources).toBe(1);
    expect(context.gains).toHaveLength(1);
    const [gain] = context.gains;
    const [compressor] = context.compressors;
    expect(context.source.connected).toEqual([gain]);
    expect(gain?.connected).toEqual([compressor]);
    expect(compressor?.connected).toEqual([context.destination]);
    expect(compressor?.threshold.value).toBe(-1);
    expect(compressor?.ratio.value).toBe(20);
    expect(gain?.gain.value).toBe(3);
    expect(context.state).toBe("running");
    expect(context.resumes).toBeGreaterThanOrEqual(1);
  });

  test("back to gain 1 bypasses the limiter without rebuilding", () => {
    const { context, amplify } = setup();
    amplify(2);
    amplify(1);
    const [gain] = context.gains;
    const [compressor] = context.compressors;
    expect(context.gains).toHaveLength(1);
    expect(gain?.gain.value).toBe(1);
    expect(gain?.connected).toEqual([context.destination]);
    expect(compressor?.connected).toEqual([]);
  });

  test("a play event resumes a suspended context", () => {
    const { media, context, amplify } = setup();
    amplify(2);
    context.state = "suspended";
    const resumes = context.resumes;
    media.dispatchEvent(new Event("play"));
    expect(context.resumes).toBe(resumes + 1);
    expect(context.state).toBe("running");
  });
});
