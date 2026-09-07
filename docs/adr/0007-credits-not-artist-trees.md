---
status: accepted
date: 2026-09-07
---

# Credits instead of artist trees

Plex and Jellyfin make artists containers of albums, which breaks on compilations, featured artists and remixes, and turns people into a second item type. Pendia follows vesta's authors table instead: a Credit links an Item to a Contributor with a role and an order, for actors, directors, authors, narrators and musical acts alike. Album is the parent of Tracks. A contributor page is a query over credits, and OpenSubsonic's tag-based browsing maps onto it directly.

## Considered options

Two entities, Person and Artist. Rejected: every role is the same mechanism, and one entity gives one page, one search index and one provider-id mapping.
