/** A plugin failure the admin can act on, with the API code it answers with. */
export class PluginError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "CONFLICT" | "NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}
