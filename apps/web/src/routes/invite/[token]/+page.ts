import { client } from "$lib/api.ts";
import { readInviteStatus } from "$lib/auth.ts";
import type { PageLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Reads the invite's status and whether OIDC can redeem it too. */
export const load: PageLoad = async ({ params }) => {
  const [{ status }, setup] = await Promise.all([
    readInviteStatus(params.token),
    client.setup.status(),
  ]);
  return {
    status,
    oidc: setup.oidcConfigured ? { name: setup.oidcName } : null,
  };
};
