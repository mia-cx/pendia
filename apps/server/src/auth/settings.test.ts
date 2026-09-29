import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrateDatabase } from "../db/migrate.ts";
import { settings } from "../db/schema/index.ts";
import { databaseUrl, withDatabase } from "../db/testing.ts";
import { createLocalUser, setupAdmin } from "./accounts.ts";
import { readAuthSettings, writeAuthSettings } from "./settings.ts";

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
      await db
        .update(settings)
        .set({ value: { artworkRequiresAuth: "yes" } })
        .where(eq(settings.key, "auth"));
      await expect(readAuthSettings(db)).rejects.toThrow(
        "Invalid auth settings.",
      );
    }));

  test("artworkRequiresAuth defaults false and round trips through the writer", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(false);
      const written = await writeAuthSettings(db, admin.id, {
        artworkRequiresAuth: true,
      });
      expect(written.artworkRequiresAuth).toBe(true);
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(true);
      await writeAuthSettings(db, admin.id, { artworkRequiresAuth: false });
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(false);
      await expect(
        writeAuthSettings(db, admin.id, {
          artworkRequiresAuth: "yes" as unknown as boolean,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }));

  test("writeAuthSettings normalizes and dedupes trusted proxy addresses", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      await writeAuthSettings(db, admin.id, {
        trustedProxyAddresses: ["10.0.0.2", "::FFFF:10.0.0.3", " 10.0.0.2 "],
      });
      expect((await readAuthSettings(db)).trustedProxyAddresses).toEqual([
        "10.0.0.2",
        "10.0.0.3",
      ]);
    }));

  test("invalid writes leave the stored auth row unchanged", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      await writeAuthSettings(db, admin.id, {
        trustedProxyAddresses: ["10.0.0.2"],
      });
      const [before] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "auth"));
      for (const patch of [
        { trustedProxyAddresses: ["not-an-ip"] },
        { trustedProxyAddresses: ["10.0.0.2", "bogus"] },
        { trustedProxyAddresses: Array.from({ length: 65 }, () => "10.0.0.2") },
        { trustedProxyAddresses: "10.0.0.2" as unknown as string[] },
      ])
        await expect(
          writeAuthSettings(db, admin.id, patch),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const [after] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "auth"));
      expect(after?.value).toEqual(before?.value);
      expect((await readAuthSettings(db)).trustedProxyAddresses).toEqual([
        "10.0.0.2",
      ]);
    }));

  test("writeAuthSettings requires manage-server", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      const viewer = await createLocalUser(db, admin.id, {
        username: "viewer",
        password: "pass",
      });
      await expect(
        writeAuthSettings(db, viewer.id, { artworkRequiresAuth: true }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        writeAuthSettings(db, viewer.id, {
          trustedProxyAddresses: ["10.0.0.2"],
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await readAuthSettings(db)).artworkRequiresAuth).toBe(false);
    }));

  test("concurrent patches to a missing row keep both writes", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      await Promise.all([
        writeAuthSettings(db, admin.id, {
          trustedProxyAddresses: ["10.0.0.2"],
        }),
        writeAuthSettings(db, admin.id, { artworkRequiresAuth: true }),
      ]);
      const stored = await readAuthSettings(db);
      expect(stored.trustedProxyAddresses).toEqual(["10.0.0.2"]);
      expect(stored.artworkRequiresAuth).toBe(true);
    }));

  test("a patch merge keeps the stored OIDC configuration readable", () =>
    withDatabase(async (db) => {
      await migrateDatabase(db);
      const admin = await setupAdmin(db, {
        username: "admin",
        password: "secret",
      });
      await db.insert(settings).values({
        key: "auth",
        value: { oidc: oidcConfig, loginMaxAttempts: 7 },
      });
      const written = await writeAuthSettings(db, admin.id, {
        artworkRequiresAuth: true,
      });
      expect(written.artworkRequiresAuth).toBe(true);
      expect(written.loginMaxAttempts).toBe(7);
      expect(written.oidc?.issuer.href).toBe(
        "https://id.mia.cx/application/o/pendia",
      );
      const [row] = await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "auth"));
      expect(row?.value).toMatchObject({
        artworkRequiresAuth: true,
        loginMaxAttempts: 7,
        oidc: { issuer: " https://ID.MIA.CX/application/o/pendia " },
      });
      const reread = await readAuthSettings(db);
      expect(reread.oidc?.issuer).toBeInstanceOf(URL);
      expect(reread.oidc?.clientSecret).toBe("secret");
      expect(reread.oidc?.scopes).toEqual(["openid", "profile", "email"]);
    }));
});
