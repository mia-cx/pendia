import { Effect, Schema } from "effect";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  libraryScanStatus,
  listLibraries,
  RootError,
  scanLibrary,
  updateLibrary,
} from "../libraries/service.ts";
import { StoredVersionPolicy } from "../stored/policy.ts";
import {
  getStoredVersionPolicy,
  setStoredVersionPolicy,
} from "../stored/service.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { ApiError, fromHost, runApi } from "./errors.ts";
import { Library, LibraryInput, LibraryUpdate, ScanStatus } from "./schema.ts";

const idInput = Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID }));

/** Like `fromHost`, but a refused root answers BAD_REQUEST with its index as `data.root`. */
const writeRoots = <A>(run: () => Promise<A>) =>
  fromHost(run).pipe(
    Effect.catchAllDefect((defect) =>
      defect instanceof RootError
        ? Effect.fail(
            new ApiError({
              code: "BAD_REQUEST",
              reason: defect.message,
              ...(defect.root === undefined
                ? {}
                : { data: { root: defect.root } }),
            }),
          )
        : Effect.die(defect),
    ),
  );
const libraryOutput = Schema.standardSchemaV1(Library);

const list = authenticated
  .route({ method: "GET", path: "/libraries" })
  .output(Schema.standardSchemaV1(Schema.Array(Library)))
  .handler(async ({ context }) =>
    runApi(fromHost(() => listLibraries(context.db, context.caller.user.id))),
  );

const get = authenticated
  .route({ method: "GET", path: "/libraries/{id}" })
  .input(idInput)
  .output(libraryOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() => getLibrary(context.db, context.caller.user.id, input.id)),
    ),
  );

const create = authenticatedMutation
  .route({ method: "POST", path: "/libraries" })
  .input(Schema.standardSchemaV1(LibraryInput))
  .output(libraryOutput)
  .handler(async ({ context, input }) =>
    runApi(
      writeRoots(() =>
        createLibrary(context.db, context.caller.user.id, input),
      ),
    ),
  );

const update = authenticatedMutation
  .route({ method: "PATCH", path: "/libraries/{id}" })
  .input(Schema.standardSchemaV1(LibraryUpdate))
  .output(libraryOutput)
  .handler(async ({ context, input: { id, ...changes } }) =>
    runApi(
      writeRoots(() =>
        updateLibrary(context.db, context.caller.user.id, id, changes),
      ),
    ),
  );

const remove = authenticatedMutation
  .route({ method: "DELETE", path: "/libraries/{id}" })
  .input(idInput)
  .output(Schema.standardSchemaV1(Schema.Struct({ ok: Schema.Boolean })))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        deleteLibrary(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const scan = authenticatedMutation
  .route({ method: "POST", path: "/libraries/{id}/scan" })
  .input(idInput)
  .output(Schema.standardSchemaV1(Schema.Struct({ jobId: Schema.UUID })))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() => scanLibrary(context.db, context.caller.user.id, input.id)),
    ),
  );

const scanStatus = authenticated
  .route({ method: "GET", path: "/libraries/{id}/scan-status" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        id: Schema.UUID,
        runId: Schema.optional(Schema.UUID),
      }),
    ),
  )
  .output(Schema.standardSchemaV1(ScanStatus))
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        libraryScanStatus(
          context.db,
          context.caller.user.id,
          input.id,
          input.runId,
        ),
      ),
    ),
  );

const policyOutput = Schema.standardSchemaV1(
  Schema.Struct({ policy: Schema.NullOr(StoredVersionPolicy) }),
);

const storedVersions = authenticated
  .route({ method: "GET", path: "/libraries/{id}/stored-versions" })
  .input(idInput)
  .output(policyOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        getStoredVersionPolicy(context.db, context.caller.user.id, input.id),
      ),
    ),
  );

const setStoredVersions = authenticatedMutation
  .route({ method: "PUT", path: "/libraries/{id}/stored-versions" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({
        id: Schema.UUID,
        policy: Schema.NullOr(StoredVersionPolicy),
      }),
    ),
  )
  .output(policyOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        setStoredVersionPolicy(
          context.db,
          context.caller.user.id,
          input.id,
          input.policy,
        ),
      ),
    ),
  );

/** The library administration procedures mounted under `libraries`. */
export const libraryProcedures = {
  list,
  get,
  create,
  update,
  delete: remove,
  scan,
  scanStatus,
  storedVersions,
  setStoredVersions,
};
