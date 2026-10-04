import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { libraries, libraryRoots } from "../db/schema/index.ts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** A test Library's columns plus the path of its one root. */
export type LibraryFixture = typeof libraries.$inferInsert & {
  rootPath: string;
};

/** Inserts test Libraries, each with one root, and returns them with that root's path and id. */
export async function insertLibraries(
  db: Database | Transaction,
  values: LibraryFixture | readonly LibraryFixture[],
) {
  const inserted: (typeof libraries.$inferSelect & {
    rootPath: string;
    rootId: string;
  })[] = [];
  for (const { rootPath, ...library } of [values].flat()) {
    const [row] = await db.insert(libraries).values(library).returning();
    if (row === undefined) throw new Error("Library insert returned no row.");
    const rootId = await addRoot(db, row.id, rootPath);
    inserted.push({ ...row, rootPath, rootId });
  }
  return inserted;
}

/** Adds a root after a test Library's last one and returns its id. */
export async function addRoot(
  db: Database | Transaction,
  libraryId: string,
  path: string,
) {
  const existing = await db
    .select({ id: libraryRoots.id })
    .from(libraryRoots)
    .where(eq(libraryRoots.libraryId, libraryId));
  const [root] = await db
    .insert(libraryRoots)
    .values({ libraryId, path, position: existing.length })
    .returning({ id: libraryRoots.id });
  if (root === undefined) throw new Error("Root insert returned no row.");
  return root.id;
}
