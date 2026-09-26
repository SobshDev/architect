import { resolve } from "node:path";

const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

/**
 * Reads the file headers of a Codex apply_patch text and returns the absolute
 * paths it leaves changed and deleted. Paths resolve against cwd; absolute
 * paths stay as they are. A move deletes the old path and changes the new one.
 * When a patch touches a path twice, its final state wins.
 */
export function patchPaths(patch: string, cwd: string): { changed: string[]; deleted: string[] } {
  const state = new Map<string, "changed" | "deleted">();
  let updating: string | undefined;
  for (const raw of patch.split("\n")) {
    // Headers start at column 0; hunk lines start with " ", "+", "-", or "@@".
    const line = raw.trimEnd();
    const path = (prefix: string) => resolve(cwd, line.slice(prefix.length).trim());
    if (line.startsWith(ADD)) {
      state.set(path(ADD), "changed");
      updating = undefined;
    } else if (line.startsWith(UPDATE)) {
      updating = path(UPDATE);
      state.set(updating, "changed");
    } else if (line.startsWith(DELETE)) {
      state.set(path(DELETE), "deleted");
      updating = undefined;
    } else if (line.startsWith(MOVE) && updating !== undefined) {
      const target = path(MOVE);
      if (target !== updating) state.set(updating, "deleted");
      state.set(target, "changed");
      updating = undefined;
    }
  }
  const pick = (kind: "changed" | "deleted") =>
    [...state].filter(([, k]) => k === kind).map(([p]) => p).sort();
  return { changed: pick("changed"), deleted: pick("deleted") };
}
