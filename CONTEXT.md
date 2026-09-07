# Pendia

A self-hosted media server that replaces Jellyfin and Plex. This glossary holds the words the project uses, so that tickets, code and docs mean the same thing by them.

## Language

**Core**:
The medium-agnostic part of Pendia: libraries, items, users, playback, plugins and roles.
_Avoid_: kernel, engine, base, platform

**Medium**:
A kind of media with its own model, scanner, browser and translation layer: movies, shows, music, books, photos, live TV, channels. Plural: mediums, because "media" already means files.
_Avoid_: media type, library type, content type, category

**Library**:
A configured root folder that holds one medium.
_Avoid_: folder, source, collection

**Item**:
Any node in a library tree: a movie, show, season, episode, album, track, book, photo, channel. It has a kind, at most one parent, metadata, artwork, credits, provider ids and per-user progress.
_Avoid_: title, entry, BaseItem, resource

**Kind**:
The medium-specific type of an Item, such as movie, show, season, episode, album, track, book, photo, channel.
_Avoid_: type, item type, class

**Version**:
One edition of an Item's content: a quality, a cut, a translation or a format. Most Items have one. Containers such as shows and albums have none.
_Avoid_: MediaSource, media, edition, quality, variant

**Format**:
What a Version is made of, which decides how a client opens it: video, audio, ebook, image.
_Avoid_: media type, mime type

**File**:
One on-disk part of a Version. Most Versions have one.
_Avoid_: part, media file, source file

**Stream**:
One track inside a File: video, audio or subtitle.
_Avoid_: track, MediaStream

**Show**:
A TV series: the parent of Seasons, which are the parents of Episodes.
_Avoid_: series, TV series, program

**Collection**:
An ordered set of Items made by a provider or a user: a film franchise, a book series, a list. An Item may belong to many Collections.
_Avoid_: box set, franchise, series, anthology, list

**Book**:
An Item in the books medium. Its Versions are ebooks or audiobooks of the same work.
_Avoid_: ebook and audiobook as separate items

**Contributor**:
A person or group credited on Items: an actor, director, writer, musician, band, author, narrator, photographer. Not a node in the library tree.
_Avoid_: person, artist, cast, crew, author, creator, people

**Credit**:
A link from an Item to a Contributor with a role and an order: actor as a character, director, main artist, featured artist, narrator.
_Avoid_: cast, crew, authorship

**Artwork**:
An image attached to an Item, or to one of its Versions, of a type: poster, backdrop, logo, thumb. Several candidates per type, one selected.
_Avoid_: image, cover, art

**Provider id**:
An Item's or Contributor's identifier at an external provider, such as TMDB, TVDB, IMDb, MusicBrainz or ISBN.
_Avoid_: external id, foreign id

**Progress**:
Where a user is in an Item and whether they finished it, recorded against the Version and Format it was made on. One word for watched, listened and read.
_Avoid_: UserData, view state, watch state, played state, resume point

**Favourite**:
A user's mark on an Item.
_Avoid_: like, heart, star

**Rating**:
A user's score for an Item, distinct from a provider's rating.
_Avoid_: score, stars

**Translation layer**:
An adapter that speaks a third-party protocol on top of Pendia's own API, so existing apps connect unchanged. One per medium: the Jellyfin API for video, OpenSubsonic for music, OPDS for books, HDHomeRun for live TV.
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
