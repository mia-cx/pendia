import { client } from "$lib/api.ts";
import { readFailure } from "$lib/errors.ts";
import { loadSession } from "$lib/session.ts";
import type { LayoutLoad } from "./$types";

export const prerender = false;
export const ssr = false;

/** Sends the browser to setup or login, or hands the shell the caller and its libraries. */
export const load: LayoutLoad = async () => {
  const { me } = await loadSession();
  let libraries: { id: string; name: string; medium: "movies" | "shows" }[];
  try {
    const result = await client.libraries.list();
    libraries = result.map(({ id, name, medium }) => ({ id, name, medium }));
  } catch (error) {
    // Viewers lack manage-libraries; they get no sidebar children.
    if (readFailure(error).code !== "FORBIDDEN") throw error;
    libraries = [];
  }
  return { me, libraries };
};
