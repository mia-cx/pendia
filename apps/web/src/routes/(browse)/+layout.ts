import { loadSession } from "$lib/session.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, or hands the shell the caller. */
export const load: LayoutLoad = () => loadSession();
