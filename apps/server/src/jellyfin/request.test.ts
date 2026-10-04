import { describe, expect, test } from "bun:test";
import {
  parseAuthorization,
  parseGuid,
  readBody,
  readClient,
  readQuery,
  toGuid,
} from "./request.ts";

const expected = {
  client: "Swiftfin iOS",
  device: "Mia's iPhone",
  deviceId: "device-1",
  version: "1.3",
  token: "abc",
};

describe("MediaBrowser header", () => {
  // Spellings from the research document: Kodi, Swift, Kotlin, web and Infuse.
  test.each([
    'MediaBrowser Client="Swiftfin iOS", Device="Mia\'s iPhone", DeviceId="device-1", Version="1.3", Token="abc"',
    "MediaBrowser DeviceId=device-1, Device=Mia's iPhone, Client=Swiftfin iOS, Version=1.3, Token=abc",
    "MediaBrowser Client=Swiftfin%20iOS, Device=Mia%27s%20iPhone, DeviceId=device-1, Version=1.3, UserId=x, Token=abc",
    'MediaBrowser Client="Swiftfin%20iOS", Version="1.3", DeviceId="device-1", Device="Mia%27s+iPhone", Token="abc"',
    'Emby Token="abc", Client="Swiftfin iOS", Version="1.3", Device="Mia\'s iPhone", DeviceId="device-1"',
  ])("parses %s", (header) => {
    expect(parseAuthorization(header)).toEqual(expected);
  });

  test("omits empty values and ignores other schemes", () => {
    expect(
      parseAuthorization('MediaBrowser Client="Web", Token=""')?.token,
    ).toBeUndefined();
    expect(parseAuthorization("Bearer abc")).toBeUndefined();
  });

  test("reads Infuse's X-Emby-Authorization when Authorization is absent", () => {
    const request = new Request("http://pendia.test/", {
      headers: {
        "X-Emby-Authorization":
          'MediaBrowser Token="t", Client="Infuse-Direct", Version="7.7", Device="Apple TV", DeviceId="d"',
      },
    });
    expect(readClient(request)).toMatchObject({
      client: "Infuse-Direct",
      token: "t",
    });
  });

  test("prefers a MediaBrowser Authorization header", () => {
    const request = new Request("http://pendia.test/", {
      headers: {
        Authorization: 'MediaBrowser Token="first"',
        "X-Emby-Authorization": 'MediaBrowser Token="second"',
      },
    });
    expect(readClient(request).token).toBe("first");
  });

  test("takes the token from the legacy token headers, never the query", () => {
    const read = (headers: Record<string, string>) =>
      readClient(
        new Request("http://pendia.test/?ApiKey=query&api_key=query", {
          headers,
        }),
      );
    expect(read({ "X-Emby-Token": "emby" }).token).toBe("emby");
    expect(
      read({
        "X-Emby-Authorization": 'MediaBrowser Client="Infuse-Direct"',
        "X-MediaBrowser-Token": "mb",
      }),
    ).toMatchObject({ client: "Infuse-Direct", token: "mb" });
    expect(read({}).token).toBeUndefined();
  });
});

describe("GUIDs", () => {
  const uuid = "0192f0c4-7b1a-7c3e-9a1b-2c3d4e5f6a7b";

  test("round trips with and without dashes", () => {
    expect(toGuid(uuid)).toBe("0192f0c47b1a7c3e9a1b2c3d4e5f6a7b");
    expect(parseGuid(toGuid(uuid))).toBe(uuid);
    expect(parseGuid(uuid.toUpperCase())).toBe(uuid);
  });

  test("rejects anything else", () => {
    expect(parseGuid("not-a-guid")).toBeUndefined();
    expect(parseGuid(`${toGuid(uuid)}0`)).toBeUndefined();
  });
});

describe("query", () => {
  test("matches names case-insensitively", () => {
    const query = readQuery(
      new URLSearchParams(
        "Secret=a&parentid=p&IncludeItemTypes=Movie,Series&includeItemTypes=Episode&Recursive=TRUE&StartIndex=5",
      ),
    );
    expect(query.get("secret")).toBe("a");
    expect(query.get("ParentId")).toBe("p");
    expect(query.list("includeItemTypes")).toEqual([
      "Movie",
      "Series",
      "Episode",
    ]);
    expect(query.flag("recursive")).toBe(true);
    expect(query.count("startIndex")).toBe(5);
    expect(query.get("missing")).toBeUndefined();
  });

  test("rejects malformed booleans and counts", () => {
    const query = readQuery(new URLSearchParams("flag=yes&limit=-1"));
    expect(() => query.flag("flag")).toThrow();
    expect(() => query.count("limit")).toThrow();
  });
});

test("body keys match case-insensitively", async () => {
  const body = await readBody(
    new Request("http://pendia.test/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mia", Pw: "secret" }),
    }),
  );
  expect(body.string("Username")).toBe("mia");
  expect(body.string("pw")).toBe("secret");
  expect(() => body.string("missing")).toThrow();
});
