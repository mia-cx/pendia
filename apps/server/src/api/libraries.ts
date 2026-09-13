import { Schema } from "effect";
import {
  createLibrary,
  deleteLibrary,
  getLibrary,
  listLibraries,
  scanLibrary,
  updateLibrary,
} from "../libraries/service.ts";
import { authenticated, authenticatedMutation } from "./context.ts";
import { fromHost, runApi } from "./errors.ts";
import { Library, LibraryInput } from "./schema.ts";

const idInput = Schema.standardSchemaV1(Schema.Struct({ id: Schema.UUID }));
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
      fromHost(() => createLibrary(context.db, context.caller.user.id, input)),
    ),
  );

const update = authenticatedMutation
  .route({ method: "PATCH", path: "/libraries/{id}" })
  .input(
    Schema.standardSchemaV1(
      Schema.Struct({ id: Schema.UUID, name: Schema.String }),
    ),
  )
  .output(libraryOutput)
  .handler(async ({ context, input }) =>
    runApi(
      fromHost(() =>
        updateLibrary(context.db, context.caller.user.id, input.id, {
          name: input.name,
        }),
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

/** The library administration procedures mounted under `libraries`. */
export const libraryProcedures = {
  list,
  get,
  create,
  update,
  delete: remove,
  scan,
};
