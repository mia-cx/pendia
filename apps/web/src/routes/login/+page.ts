import { redirect } from "@sveltejs/kit";
import { client } from "$lib/api.ts";
import type { PageLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup when no admin exists yet. */
export const load: PageLoad = async () => {
  const { complete } = await client.setup.status();
  if (!complete) redirect(307, "/setup");
};
