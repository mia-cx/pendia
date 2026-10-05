---
status: accepted
date: 2026-10-05
---

# An Item is its folder plus a title key

Scans used to find a show or movie by its folder relative to the root. That stops working once a root can be one show, and once loose files of several titles share a folder: two single-show roots both sit at `.`, and `Movies/Dune.2021.mkv` and `Movies/Arrival.2016.mkv` share `Movies`. Pendia keeps the folder and adds `items.title_key`. The key is empty when the folder below the root names one title, which is every Item that existed before. Otherwise it is the normalised title and year from the root's or the file's name, such as `breaking bad (2008)`.

The folder stays the anchor for colocated `.pendia` assets, so it has to be a real folder. Identifying Items by title alone would merge `4K/Dune (2021)` with `HD/Dune (2021)`, which are two Items today.

## Consequences

The migration adds a column whose default is right for every existing row, so a rescan after the upgrade changes nothing. A show that is a root of its own and the same show as a folder in another root have different folders. A scan with no exact match merges into the one Item with the same title and year or provider tag, and finds it again later by the Files it already owns. Such an Item's folder is the one in its home root, and only a scan whose group holds every File the Item has there moves it, so its two halves never flip its folder back and forth.

An Item keeps every File it already owns, even when the new rules would group that File elsewhere. A movie split across disc folders before this change, or several movies in one folder without a year, stay the Items they were. Regrouping them would have to move user state and Stored Versions between Items. New files follow the new rules.

A scan resolves each group against the webhook ids earlier groups of the same scan asserted, before stored ids, so two Files asserting one id in one scan become one Item. It writes ids once per Item, merging what its groups assert. Webhook ids and folder tags merge separately. If two groups give one provider different values, the Item gets none of that source's ids, so a legacy Item holding several movies keeps its match. The trade-off is that if only one group of such an Item asserts, that assertion applies, because webhook ids are authoritative.
