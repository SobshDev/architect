/** A file that install must merge into cannot be parsed, so it is left untouched. */
export class InstallError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = "InstallError";
    this.path = path;
  }
}
