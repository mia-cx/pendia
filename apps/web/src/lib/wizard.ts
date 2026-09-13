import { createPendiaClient, type PendiaClient } from "./api.ts";
import { createFirstAdmin, type PublicUser, signIn } from "./auth.ts";
import { waitForScan } from "./scan.ts";

/** The extra arguments every wizard step accepts for tests. */
export type WizardOptions = {
  origin?: string;
  fetch?: typeof globalThis.fetch;
};

/** The signed-in caller and its client that later wizard steps need. */
export type WizardSession = {
  user: PublicUser;
  client: PendiaClient;
};

/** Reports whether the first-run wizard still needs to run. */
export async function setupOpen(options: WizardOptions = {}) {
  const { complete } = await createPendiaClient({
    origin: options.origin,
  }).setup.status();
  return !complete;
}

/** Creates the first admin, signs in and returns the wizard session. */
export async function createAdmin(
  input: { username: string; password: string; displayName?: string },
  options: WizardOptions = {},
): Promise<WizardSession> {
  await createFirstAdmin(input, options);
  const { token, user } = await signIn(
    { username: input.username, password: input.password },
    options,
  );
  return {
    user,
    client: createPendiaClient({
      origin: options.origin,
      headers: { authorization: `Bearer ${token}` },
    }),
  };
}

/** Creates the first library as a movies library and starts its scan. */
export async function createFirstLibrary(
  session: WizardSession,
  input: { name: string; rootPath: string },
) {
  const library = await session.client.libraries.create({
    name: input.name,
    medium: "movies",
    rootPath: input.rootPath,
  });
  const { jobId } = await session.client.libraries.scan({ id: library.id });
  return { library, jobId };
}

/** Runs the whole first-run wizard and returns its settled scan status. */
export async function runFirstRunWizard(
  input: {
    username: string;
    password: string;
    displayName?: string;
    libraryName: string;
    rootPath: string;
  },
  options: WizardOptions = {},
) {
  const session = await createAdmin(input, options);
  const { library, jobId } = await createFirstLibrary(session, {
    name: input.libraryName,
    rootPath: input.rootPath,
  });
  const status = await waitForScan(session.client, library.id);
  return { session, library, jobId, status };
}
