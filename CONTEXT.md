# Pendia

A self-hosted media server that replaces Jellyfin and Plex. This glossary holds the words the project uses, so that tickets, code and docs mean the same thing by them.

## Language

**Core**:
The medium-agnostic part of Pendia: libraries, items, users, playback, plugins and roles.
_Avoid_: kernel, engine, base, platform

**Medium**:
A kind of media with its own model, scanner, browser and translation layer: movies, series, music, photos, ebooks, audiobooks, live TV, channels. Plural: mediums, because "media" already means files.
_Avoid_: media type, library type, content type, category

**Library**:
A configured root folder that holds one medium.
_Avoid_: folder, source, collection

**Translation layer**:
An adapter that speaks a third-party protocol on top of Pendia's own API, so existing apps connect unchanged. One per medium: the Jellyfin API for video, OpenSubsonic for music, OPDS for ebooks, HDHomeRun for live TV.
_Avoid_: compat layer, shim, emulation, bridge

**Role**:
The job a running Pendia process performs: api, worker, transcoder, watcher, or all.
_Avoid_: service, microservice, mode, component

**Plugin**:
Trusted TypeScript code an admin installs to extend Pendia, reaching the core only through the host interface.
_Avoid_: extension, addon, module

**Provider**:
A plugin-supplied source of metadata, artwork or subtitles for items.
_Avoid_: scraper, agent, fetcher
