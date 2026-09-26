import { describe, expect, test } from "bun:test";
import { patchPaths } from "./index.ts";

const cwd = "/home/user/project";

describe("patchPaths", () => {
  test("adds and updates are changed, deletes are deleted, all resolved against cwd", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "*** Update File: src/app.ts",
      "@@ function main()",
      "-  old();",
      "+  next();",
      "*** Delete File: src/old.ts",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch, cwd)).toEqual({
      changed: ["/home/user/project/src/app.ts", "/home/user/project/src/new.ts"],
      deleted: ["/home/user/project/src/old.ts"],
    });
  });

  test("a move deletes the old path and changes the new one", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/lib/a.ts",
      "@@",
      "-x",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch, cwd)).toEqual({
      changed: ["/home/user/project/src/lib/a.ts"],
      deleted: ["/home/user/project/src/a.ts"],
    });
  });

  test("reads CRLF patches and paths with spaces", () => {
    const patch = "*** Begin Patch\r\n*** Add File: docs/my notes.md\r\n+hi\r\n*** Delete File: old dir/x.py\r\n*** End Patch\r\n";
    expect(patchPaths(patch, cwd)).toEqual({
      changed: ["/home/user/project/docs/my notes.md"],
      deleted: ["/home/user/project/old dir/x.py"],
    });
  });

  test("keeps absolute paths and paths outside cwd as absolute paths", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /elsewhere/tool.ts",
      "+x",
      "*** Update File: ../sibling/b.ts",
      "@@",
      "+y",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch, cwd).changed).toEqual(["/elsewhere/tool.ts", "/home/user/sibling/b.ts"]);
  });

  test("ignores header-like text inside hunks", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: README.md",
      "@@",
      " *** Add File: context.md",
      "+*** Delete File: added-line.md",
      "-*** Move to: removed-line.md",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch, cwd)).toEqual({ changed: ["/home/user/project/README.md"], deleted: [] });
  });

  test("the final state of a path wins and output is sorted and unique", () => {
    const patch = [
      "*** Begin Patch",
      "*** Delete File: b.ts",
      "*** Update File: a.ts",
      "*** Move to: c.ts",
      "*** Add File: b.ts",
      "+new",
      "*** Update File: ./c.ts",
      "@@",
      "+z",
      "*** End Patch",
    ].join("\n");
    expect(patchPaths(patch, cwd)).toEqual({
      changed: ["/home/user/project/b.ts", "/home/user/project/c.ts"],
      deleted: ["/home/user/project/a.ts"],
    });
  });

  test("a move onto the same path is only a change", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n*** Move to: ./a.ts\n*** End Patch";
    expect(patchPaths(patch, cwd)).toEqual({ changed: ["/home/user/project/a.ts"], deleted: [] });
  });
});
