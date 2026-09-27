import type { EdgeTarget, ImportResolver, RawImport, ResolverInput } from "../../model/index.ts";
import { selectFiles } from "../graph/select.ts";

/** The [package] name of a manifest, or null for virtual (workspace-only) manifests and invalid TOML. */
export function packageName(text: string): string | null {
  try {
    const name = ((Bun.TOML.parse(text) as Record<string, unknown>).package as Record<string, unknown> | undefined)?.name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch {
    return null;
  }
}

/** Crates in the repository by package name, each mapped to its Cargo.toml; the first path wins on a duplicate name. */
export async function repoCrates(input: Pick<ResolverInput, "source" | "files" | "settings">): Promise<Map<string, string>> {
  const manifests = selectFiles(input.files, input.settings, ["cargo.toml"]);
  const texts = await input.source.readFiles(manifests);
  const crates = new Map<string, string>();
  for (const path of manifests) {
    const name = packageName(texts.get(path) ?? "");
    if (name !== null && !crates.has(name)) crates.set(name, path);
  }
  return crates;
}

/** Crates of the repository resolve to their manifest; every other dependency is an external package. */
export async function createCargoResolver(input: ResolverInput): Promise<ImportResolver> {
  const crates = await repoCrates(input);
  return {
    resolve(_from: string, raw: RawImport): EdgeTarget[] {
      const to = crates.get(raw.specifier);
      return [to === undefined ? { package: raw.specifier } : { to }];
    },
  };
}
