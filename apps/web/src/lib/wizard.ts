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

/** The mediums a first library can take. */
export type LibraryMedium = Parameters<
  PendiaClient["libraries"]["create"]
>[0]["medium"];

/** Creates the first library for the chosen medium. */
export async function createFirstLibrary(
  session: WizardSession,
  input: { name: string; rootPath: string; medium: LibraryMedium },
) {
  return session.client.libraries.create({
    name: input.name,
    medium: input.medium,
    rootPath: input.rootPath,
  });
}

/** Starts a library scan and returns the run's root job id. */
export async function startScan(session: WizardSession, libraryId: string) {
  return session.client.libraries.scan({ id: libraryId });
}

/** Runs the whole first-run wizard and returns its settled scan status. */
export async function runFirstRunWizard(
  input: {
    username: string;
    password: string;
    displayName?: string;
    libraryName: string;
    rootPath: string;
    libraryMedium: LibraryMedium;
  },
  options: WizardOptions & { timeoutMs?: number } = {},
) {
  const session = await createAdmin(input, options);
  const library = await createFirstLibrary(session, {
    name: input.libraryName,
    rootPath: input.rootPath,
    medium: input.libraryMedium,
  });
  const { jobId } = await startScan(session, library.id);
  const status = await waitForScan(session.client, library.id, {
    timeoutMs: options.timeoutMs,
    runId: jobId,
  });
  return { session, library, jobId, status };
}
