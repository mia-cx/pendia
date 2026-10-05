import type { PendiaClient } from "./api.ts";

/** One permission name, taken from the API's own group shape. */
export type Permission = Awaited<
  ReturnType<PendiaClient["groups"]["list"]>
>[number]["permissions"][number];

// Every permission needs a key here, so the build fails when the server adds one.
const displayOrder = {
  view: 1,
  play: 2,
  "manage-libraries": 3,
  "manage-metadata": 4,
  "manage-subtitles": 5,
  "manage-users": 6,
  "manage-plugins": 7,
  "manage-transcoding": 8,
  "manage-server": 9,
} satisfies Record<Permission, number>;

/** Every permission name the server enforces, in the order the screens show them. */
export const permissionNames = Object.keys(
  displayOrder,
) as (keyof typeof displayOrder)[];

/** The readable name of each permission. */
export const permissionLabels = {
  view: "View",
  play: "Play",
  "manage-libraries": "Manage libraries",
  "manage-metadata": "Edit metadata",
  "manage-subtitles": "Manage subtitles",
  "manage-users": "Manage users",
  "manage-plugins": "Manage plugins",
  "manage-transcoding": "Manage transcoding",
  "manage-server": "Manage server",
} satisfies Record<Permission, string>;
