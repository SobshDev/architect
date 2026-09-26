#!/usr/bin/env bun
// Clones the reference corpus listed in knowledge/corpus.yaml into data/repos at the pinned commits.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

interface CorpusRepo {
  dir: string;
  url: string;
  sha: string;
}

const root = join(import.meta.dir, "..");
const manifest = parse(await Bun.file(join(root, "knowledge/corpus.yaml")).text()) as { repos: CorpusRepo[] };
const target = join(root, "data/repos");

for (const repo of manifest.repos) {
  const dir = join(target, repo.dir);
  if (!existsSync(dir)) {
    console.error(`cloning ${repo.url}`);
    await run(["git", "clone", "--quiet", repo.url, dir]);
  }
  await run(["git", "-C", dir, "fetch", "--quiet", "origin", repo.sha]);
  await run(["git", "-C", dir, "checkout", "--quiet", "--detach", repo.sha]);
  console.error(`${repo.dir} at ${repo.sha.slice(0, 7)}`);
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}
