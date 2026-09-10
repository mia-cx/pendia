# Plugins

Trusted TypeScript that extends Pendia. Declarations: [plugin-api.d.ts](./plugin-api.d.ts).

## Package

A plugin is an npm package or a folder with a `pendia` block in `package.json`: the host API range, the capabilities it uses, the hosts it may reach, a JSON Schema for its config, and the entry module.

```json
{
  "name": "pendia-plugin-prunarr",
  "pendia": {
    "api": "^1.0.0",
    "capabilities": ["items:read", "progress:read", "shelves", "jobs", "network"],
    "network": ["radarr.example", "sonarr.example"],
    "config": { "type": "object", "properties": { "radarrUrl": { "type": "string" } } },
    "entry": "./dist/index.js"
  }
}
```

Install from an npm name, a local folder, a tarball URL, or a registry entry. The plugin is imported on first use, not at boot, so an installed plugin costs nothing until something calls it.

## Registries

A registry is a JSON manifest listing plugins and their versions. An admin adds registry URLs; a GitHub repo serving `pendia-registry.json` at its root is a registry. Pendia ships with the official registry configured, which is where the first-party plugins live.

## The host object

The entry module calls `definePlugin(host => ...)`. Everything a plugin can reach is on `host`, and Pendia builds that object per plugin: a capability the plugin did not declare, or the admin switched off, is absent. Plugins never import Pendia internals.

Every argument and result across this boundary is JSON-serialisable, and every call returns a plain Promise. Plugin authors write ordinary async TypeScript and never meet Effect.

## Capabilities

Declared in the manifest, approved at install. `files` is the loud one: it lets a plugin read, write and delete inside libraries, so its install screen warns that the plugin can change the media collection, and an admin can switch it off per plugin or globally, for a while or for good. There are no file handles. A plugin asks Pendia to act on a path, and Pendia decides.

`network` is restricted to the hosts in the manifest.

## Providers

Metadata, subtitle and artwork providers register through `host.providers`. The first-party providers, TMDB, TVDB and OpenSubtitles, use the same contract, in-tree, which is what proves the contract carries real work. More free and open metadata providers follow as first-party plugins in the official registry. Provider order and per-library enablement are admin settings.

## Failure

A plugin that throws is marked failed, with the error in the admin log, and stays disabled until an admin re-enables it. The host never crashes for a plugin. No hot reload: restart the plugin from the admin.

## Reference plugins

- Webhooks: any server event to an HTTP endpoint with a body template. First-party, and the plugin the interface is designed against.
- [Prunarr](https://github.com/mia-riezebos/jellyfin-plugin-prunarr): needs items, per-user progress, scheduled jobs, arr HTTP calls and a "Leaving Soon" shelf. All five are in the v1 interface.
