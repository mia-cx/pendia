---
status: accepted
date: 2026-09-07
---

# Item, Version, File, Stream

Jellyfin flattens editions and parts into one MediaSource list, which is why multi-part and multi-edition media misbehave there. Pendia separates them. An Item is the named thing. A Version is one edition of it: a quality, a cut, a translation, a format. A File is one on-disk part of a Version. A Stream is one track in a File. Containers are Items with children and no Versions, so shows, albums and live channels need no special cases.

## Consequences

Progress is per Item, but a position is recorded against the Version and Format it was made on, and resumes on another Version only when the two are compatible. Books are one medium whose Versions are ebooks or audiobooks of the same work, so reading and listening share one Item.
