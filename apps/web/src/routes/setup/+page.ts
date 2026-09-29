import { redirect } from "@sveltejs/kit";
import { setupOpen } from "$lib/wizard.ts";
import type { PageLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to login when setup is already complete. */
export const load: PageLoad = async () => {
  if (!(await setupOpen())) redirect(307, "/login");
};
