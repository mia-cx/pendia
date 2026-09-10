# Medium contract

A medium is an in-tree module that teaches the core about one kind of media. Declarations: [medium.d.ts](./medium.d.ts).

Movies and shows are two mediums, not one. They share a probe, the video format and the playback engine through a video-common module, and differ where it counts: a show is a tree of seasons and episodes, a movie is a leaf.

## What a medium hands over

1. Kinds, each with the extra columns it adds and whether it holds Versions. Shows: Show, Season, Episode, where only Episode holds Versions.
2. Scan rules: which paths in a library belong to it, what a canonical folder is, how to parse one, and which files inside are extras rather than Versions.
3. Providers it consumes: metadata, subtitles, artwork.
4. Formats it plays.
5. Browse: which core shelves its Items join, the shelves only it can compute, and the client route per kind.
6. Translation: the protocol its clients speak, the Jellyfin API for video.

## Home

Home is a core screen assembled from shelves. Three are core: continue watching, recently added, recently played. A medium lists the ones it joins, so nothing appears where it makes no sense. Movies and shows join continue watching and recently added. Music, later, joins recently added and recently played and stays out of continue watching. Mediums add their own shelves next to the core ones, and shows contribute next up. Plugins add shelves through the same mechanism.

## Deferred mediums, checked in the abstract

- Music: kinds Artist, Album, Track, with Versions on Track. Scan is tag-based, so `identify` reads the file rather than the path, which the contract allows. Its translation layer is OpenSubsonic. Fits.
- Books: kind Book with ebook and audiobook Versions, so one Item carries two formats. `formats` is a list for exactly this. Its translation layer is OPDS. Fits.
- Photos: kind Photo, one Version, image format. No provider metadata. Fits, with browse doing the interesting work.
- Live TV: kind Channel with no Versions and no files, so `identify` never fires and a channel arrives from an M3U instead. The contract needs a second source of Items besides the scanner. Does not fit as written.
- Channels: scheduled from Items already in the library, so it consumes other mediums rather than owning kinds. Does not fit as written.

Live TV and channels are the two that will change this interface. Both are past the MVP, and neither is worth designing for now.
