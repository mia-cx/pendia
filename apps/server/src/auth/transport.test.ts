import { describe, expect, test } from "bun:test";
import { normalizeAddress, requestIdentity } from "./transport.ts";

function req(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers });
}

describe("transport identity", () => {
  test("normalizes IPv6 spelling and folds IPv4-mapped addresses", () => {
    expect(normalizeAddress("192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeAddress(" 192.0.2.1 ")).toBe("192.0.2.1");
    expect(normalizeAddress("2001:0DB8:0:0:0:0:0:0001")).toBe("2001:db8::1");
    expect(normalizeAddress("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(normalizeAddress("::FFFF:C000:201")).toBe("192.0.2.1");
    expect(normalizeAddress("example.com")).toBeUndefined();
    expect(normalizeAddress("192.0.2.1:8080")).toBeUndefined();
    expect(normalizeAddress("")).toBeUndefined();
  });

  test("untrusted peers ignore every forwarding header", () => {
    const request = req("http://pendia.local/api", {
      forwarded: "for=1.2.3.4;proto=https",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
    });
    expect(requestIdentity(request, "10.0.0.9", ["10.0.0.2"])).toEqual({
      address: "10.0.0.9",
      secure: false,
    });
    const direct = req("https://pendia.local/api", {
      "x-forwarded-proto": "http",
    });
    expect(requestIdentity(direct, "10.0.0.9", ["10.0.0.2"])).toEqual({
      address: "10.0.0.9",
      secure: true,
    });
    expect(requestIdentity(req("http://x/"), "garbage", [])).toEqual({
      address: "0.0.0.0",
      secure: false,
    });
    const spoof = req("http://x/", {
      forwarded: "for=1.2.3.4;proto=https",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
    });
    expect(requestIdentity(spoof, "garbage", ["0.0.0.0"])).toEqual({
      address: "0.0.0.0",
      secure: false,
    });
  });

  test("trusted Forwarded chain walks to the first untrusted hop", () => {
    const trusted = ["10.0.0.2", "10.0.0.9"];
    const request = req("http://pendia.local/api", {
      forwarded:
        'for="[2001:DB8::1]:8443";proto=https, for=198.51.100.5;proto=http',
    });
    expect(requestIdentity(request, "10.0.0.2", trusted)).toEqual({
      address: "198.51.100.5",
      secure: false,
    });
    const deeper = req("http://pendia.local/api", {
      forwarded:
        'for="[2001:db8::1]";proto=https, for=10.0.0.9;proto=http, for=203.0.113.7;proto=https',
    });
    expect(requestIdentity(deeper, "10.0.0.2", trusted)).toEqual({
      address: "203.0.113.7",
      secure: true,
    });
    const single = req("http://pendia.local/api", {
      forwarded: "for=203.0.113.9;proto=https",
    });
    expect(requestIdentity(single, "10.0.0.2", trusted)).toEqual({
      address: "203.0.113.9",
      secure: true,
    });
  });

  test("XFF walks right to left and stops at the first untrusted hop", () => {
    const trusted = ["10.0.0.2", "10.0.0.9"];
    const request = req("http://pendia.local/api", {
      "x-forwarded-for": "1.1.1.1, 8.8.8.8, 10.0.0.9",
    });
    expect(requestIdentity(request, "10.0.0.2", trusted)).toEqual({
      address: "8.8.8.8",
      secure: false,
    });
    const malformed = req("http://pendia.local/api", {
      "x-forwarded-for": "8.8.8.8, not-an-ip",
    });
    expect(requestIdentity(malformed, "10.0.0.2", trusted)).toEqual({
      address: "10.0.0.2",
      secure: false,
    });
    const badForwarded = req("http://pendia.local/api", {
      forwarded: "for=8.8.8.8, for=_obfuscated",
    });
    expect(requestIdentity(badForwarded, "10.0.0.2", trusted)).toEqual({
      address: "10.0.0.2",
      secure: false,
    });
  });

  test("forwarded protocol only applies through trusted peers", () => {
    const trusted = ["10.0.0.2"];
    expect(
      requestIdentity(
        req("http://pendia.local/api", { "x-forwarded-proto": "https" }),
        "10.0.0.2",
        trusted,
      ),
    ).toEqual({ address: "10.0.0.2", secure: true });
    const chained = req("http://pendia.local/api", {
      "x-forwarded-for": "8.8.8.8, 9.9.9.9",
      "x-forwarded-proto": "https, http",
    });
    expect(requestIdentity(chained, "10.0.0.2", trusted)).toEqual({
      address: "9.9.9.9",
      secure: false,
    });
    const mapped = req("https://pendia.local/api", {
      forwarded: "for=203.0.113.9;proto=https",
    });
    expect(requestIdentity(mapped, "::ffff:10.0.0.2", trusted)).toEqual({
      address: "203.0.113.9",
      secure: true,
    });
    const wrongList = req("http://pendia.local/api", {
      "x-forwarded-for": "8.8.8.8",
      "x-forwarded-proto": "https, http",
    });
    expect(requestIdentity(wrongList, "10.0.0.2", trusted)).toEqual({
      address: "8.8.8.8",
      secure: false,
    });
  });
});
