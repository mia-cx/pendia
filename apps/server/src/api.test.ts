import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApiServer } from "./api.ts";

test("the api server answers its liveness check", async () => {
  const server = startApiServer(0);

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);

    expect(response.status).toBe(200);
  } finally {
    await server.stop(true);
  }
});

let fixtureRoot: string;
let previousWebRoot: string | undefined;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "pendia-web-"));
  writeFileSync(join(fixtureRoot, "index.html"), "<h1>Pendia index</h1>");
  writeFileSync(join(fixtureRoot, "200.html"), "<h1>Pendia shell</h1>");
  previousWebRoot = Bun.env.PENDIA_WEB_ROOT;
  Bun.env.PENDIA_WEB_ROOT = fixtureRoot;
});

afterEach(() => {
  if (previousWebRoot === undefined) {
    delete Bun.env.PENDIA_WEB_ROOT;
  } else {
    Bun.env.PENDIA_WEB_ROOT = previousWebRoot;
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test("the web root serves the prerendered page at / and the shell elsewhere", async () => {
  const server = startApiServer(0);
  const base = `http://127.0.0.1:${server.port}`;

  try {
    expect(await (await fetch(`${base}/`)).text()).toContain("Pendia index");
    expect(await (await fetch(`${base}/some/client/route`)).text()).toContain(
      "Pendia shell",
    );
  } finally {
    await server.stop(true);
  }
});
