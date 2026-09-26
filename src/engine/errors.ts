/** A usage or configuration problem the user has to fix. The CLI prints the message and exits with code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}
