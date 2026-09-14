import { redirect } from "@sveltejs/kit";
import { client } from "$lib/api.ts";
import { readFailure } from "$lib/errors.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, or hands the shell the caller. */
export const load: LayoutLoad = async () => {
  const { complete } = await client.setup.status();
  if (!complete) redirect(307, "/setup");
  try {
    return { me: await client.me() };
  } catch (error) {
    if (readFailure(error).code === "UNAUTHORIZED") redirect(307, "/login");
    throw error;
  }
};
