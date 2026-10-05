/** Puts the group a save answered with into the cached list, then refreshes it, so a failed refresh still leaves the saved permissions to edit from. */
export async function cacheSavedGroup<G extends { readonly id: string }>(
  list: {
    readonly data: readonly G[] | undefined;
    set(value: readonly G[]): void;
    reload(): Promise<void>;
  },
  saved: G,
) {
  if (list.data)
    list.set(list.data.map((row) => (row.id === saved.id ? saved : row)));
  await list.reload();
}
