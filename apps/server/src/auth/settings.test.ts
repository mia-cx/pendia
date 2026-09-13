import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrateDatabase } from "../db/migrate.ts";
import { settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { readAuthSettings } from "./settings.ts";

const oidcConfig = {
  issuer: " https://ID.MIA.CX/application/o/pendia ",
  clientId: " pendia ",
  clientSecret: " secret ",
  scopes: ["openid", " profile ", "openid", "email", "profile"],
};

describe.skipIf(!databaseUrl)("auth OIDC settings", () => {
  test("missing auth row returns defaults with oidc disabled", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      expect(await readAuthSettings(db)).toEqual({
        sessionMaxAgeSeconds: null,
        loginMaxAttempts: 5,
        loginWindowSeconds: 900,
        trustedProxyAddresses: [],
        artworkRequiresAuth: false,
        oidc: null,
      });
    }));

  test("valid config normalizes issuer, trims values and dedupes scopes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({
        key: "auth",
        value: { oidc: oidcConfig, unknownKey: true },
      });
      const { oidc } = await readAuthSettings(db);
      expect(oidc?.issuer).toBeInstanceOf(URL);
      expect(oidc?.issuer.href).toBe("https://id.mia.cx/application/o/pendia");
      expect(oidc?.clientId).toBe("pendia");
      expect(oidc?.clientSecret).toBe("secret");
      expect(oidc?.scopes).toEqual(["openid", "profile", "email"]);
      await db
        .update(settings)
        .set({
          value: {
            oidc: { ...oidcConfig, issuer: "http://127.0.0.1:9000/op" },
          },
        })
        .where(eq(settings.key, "auth"));
      expect((await readAuthSettings(db)).oidc?.issuer.href).toBe(
        "http://127.0.0.1:9000/op",
      );
      await db
        .update(settings)
        .set({ value: { oidc: null } })
        .where(eq(settings.key, "auth"));
      expect((await readAuthSettings(db)).oidc).toBeNull();
    }));

  test("artworkRequiresAuth accepts booleans and rejects other values", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db
        .insert(settings)
        .values({ key: "auth", value: { artworkRequiresAuth: true } });
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(true);
      await db
        .update(settings)
        .set({ value: { artworkRequiresAuth: false } })
        .where(eq(settings.key, "auth"));
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(false);
      for (const artworkRequiresAuth of ["yes", 1, null, {}]) {
        await db
          .update(settings)
          .set({ value: { artworkRequiresAuth } })
          .where(eq(settings.key, "auth"));
        await expect(readAuthSettings(db)).rejects.toThrow(
          "Invalid auth settings.",
        );
      }
    }));

  test("malformed config rejects with the shared settings error", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      await db.insert(settings).values({ key: "auth", value: {} });
      for (const oidc of [
        "oops",
        42,
        [],
        { ...oidcConfig, issuer: "not a url" },
        { ...oidcConfig, issuer: "id.mia.cx" },
        { ...oidcConfig, issuer: "ftp://id.mia.cx" },
        { ...oidcConfig, issuer: "http://id.mia.cx" },
        { ...oidcConfig, issuer: "https://user:pass@id.mia.cx" },
        { ...oidcConfig, issuer: "https://id.mia.cx/?x=1" },
        { ...oidcConfig, issuer: "https://id.mia.cx/#frag" },
        { ...oidcConfig, clientId: "  " },
        { ...oidcConfig, clientSecret: "" },
        { ...oidcConfig, scopes: "openid" },
        { ...oidcConfig, scopes: ["openid", " "] },
        { ...oidcConfig, scopes: ["openid profile"] },
        { ...oidcConfig, scopes: ["openid", 'bad"scope'] },
        { ...oidcConfig, scopes: ["openid", "bad\\scope"] },
        { ...oidcConfig, scopes: [] },
        { ...oidcConfig, scopes: ["profile", "email"] },
      ]) {
        await db
          .update(settings)
          .set({ value: { oidc } })
          .where(eq(settings.key, "auth"));
        await expect(readAuthSettings(db)).rejects.toThrow(
          "Invalid auth settings.",
        );
      }
    }));
});
