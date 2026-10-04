import { redirect } from "@sveltejs/kit";
import { client } from "$lib/api.ts";
import type { PageLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup when no admin exists yet, else reads OIDC and any callback error. */
export const load: PageLoad = async ({ url }) => {
  const { complete, oidcConfigured, oidcName } = await client.setup.status();
  if (!complete) redirect(307, "/setup");
  return {
    oidc: oidcConfigured ? { name: oidcName } : null,
    error: url.searchParams.get("error"),
  };
};
