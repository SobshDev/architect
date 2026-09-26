import type { FileSource } from "../../model/index.ts";
import { git, GIT_ENV, resolveRef, splitNul } from "./git.ts";
import { decodeText } from "./text.ts";

/** Requests written to cat-file per batch, small enough that the request text fits in a pipe buffer. */
const BATCH = 256;
const REGULAR_MODES = new Set(["100644", "100755"]);

/** A commit read straight from git objects, without a checkout. Call close() when done. */
export class GitSource implements FileSource {
  readonly label: string;
  readonly root: string;
  readonly revision: string;
  private tree: Promise<Map<string, string>> | null = null;
  private readonly catFile: CatFile;

  constructor(root: string, ref: string, revision: string) {
    this.root = root;
    this.revision = revision;
    this.label = `${ref}@${revision.slice(0, 7)}`;
    this.catFile = new CatFile(root);
  }

  async listFiles(): Promise<string[]> {
    return [...(await this.blobs()).keys()].sort();
  }

  async readFile(path: string): Promise<string | null> {
    const sha = (await this.blobs()).get(path);
    if (sha === undefined) return null;
    const bytes = (await this.catFile.read([sha])).get(sha);
    return bytes ? decodeText(bytes) : null;
  }

  async readFiles(paths: readonly string[]): Promise<Map<string, string>> {
    const blobs = await this.blobs();
    const wanted = new Map<string, string>();
    for (const path of paths) {
      const sha = blobs.get(path);
      if (sha !== undefined) wanted.set(path, sha);
    }
    const shas = [...new Set(wanted.values())];
    const batches: Promise<Map<string, Uint8Array | null>>[] = [];
    for (let i = 0; i < shas.length; i += BATCH) batches.push(this.catFile.read(shas.slice(i, i + BATCH)));
    const texts = new Map<string, string | null>();
    for (const batch of await Promise.all(batches)) {
      for (const [sha, bytes] of batch) texts.set(sha, bytes ? decodeText(bytes) : null);
    }
    const out = new Map<string, string>();
    for (const [path, sha] of wanted) {
      const text = texts.get(sha);
      if (text !== null && text !== undefined) out.set(path, text);
    }
    return out;
  }

  /** The blob sha, which equals contentId() of the same text. */
  async stamp(path: string): Promise<string | null> {
    return (await this.blobs()).get(path) ?? null;
  }

  /** Stops the cat-file process. Later reads throw. */
  close(): void {
    this.catFile.close();
  }

  private blobs(): Promise<Map<string, string>> {
    this.tree ??= readTree(this.root, this.revision);
    return this.tree;
  }
}

/** Opens the commit `ref` names. `root` must be the top of the work tree. */
export async function openGitSource(root: string, ref: string): Promise<GitSource> {
  const sha = await resolveRef(root, ref);
  if (sha === null) throw new Error(`"${ref}" does not resolve to a commit in ${root}`);
  return new GitSource(root, ref, sha);
}

/** Path to blob sha for the regular files of a commit; symlinks and submodules are skipped. */
async function readTree(root: string, sha: string): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  for (const entry of splitNul(await git(root, ["ls-tree", "-r", "-z", "--full-tree", sha]))) {
    // "<mode> SP <type> SP <object> TAB <path>"
    const tab = entry.indexOf("\t");
    const [mode, type, object] = entry.slice(0, tab).split(" ");
    if (type === "blob" && object && REGULAR_MODES.has(mode ?? "")) blobs.set(entry.slice(tab + 1), object);
  }
  return blobs;
}

type Proc = Bun.Subprocess<"pipe", "pipe", "ignore">;

/** One long-lived "git cat-file --batch" process. Requests run one batch at a time so responses never interleave. */
class CatFile {
  private proc: Proc | null = null;
  private reader: ByteReader | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly root: string) {}

  /** Blob bytes by sha; null for objects git reports missing. */
  read(shas: readonly string[]): Promise<Map<string, Uint8Array | null>> {
    const run = this.queue.then(() => this.exchange(shas));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.closed = true;
    this.reset();
  }

  private reset(): void {
    const proc = this.proc;
    this.proc = null;
    this.reader = null;
    if (proc) proc.kill();
  }

  private async exchange(shas: readonly string[]): Promise<Map<string, Uint8Array | null>> {
    if (this.closed) throw new Error("GitSource is closed");
    const { proc, reader } = this.start();
    proc.stdin.write(shas.map((sha) => `${sha}\n`).join(""));
    const flushed = proc.stdin.flush();
    const out = new Map<string, Uint8Array | null>();
    try {
      for (const sha of shas) {
        const header = (await reader.readLine()).split(" ");
        if (header[1] === "missing" || header.length !== 3) {
          out.set(sha, null);
          continue;
        }
        const bytes = await reader.readBytes(Number(header[2]));
        await reader.readBytes(1); // trailing newline
        out.set(sha, bytes);
      }
    } catch (error) {
      this.reset();
      throw error;
    }
    await flushed;
    return out;
  }

  private start(): { proc: Proc; reader: ByteReader } {
    if (this.proc && this.reader) return { proc: this.proc, reader: this.reader };
    const proc = Bun.spawn(["git", "cat-file", "--batch"], {
      cwd: this.root,
      env: GIT_ENV,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.unref();
    proc.stdin.unref();
    const reader = new ByteReader(proc.stdout.getReader());
    this.proc = proc;
    this.reader = reader;
    return { proc, reader };
  }
}

/** Reads lines and exact byte counts from a stream whose chunks split anywhere. */
class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;

  constructor(private readonly stream: { read(): Promise<{ done: boolean; value?: Uint8Array }> }) {}

  async readLine(): Promise<string> {
    for (;;) {
      const newline = this.buf.indexOf(10, this.pos);
      if (newline >= 0) {
        const line = new TextDecoder().decode(this.buf.subarray(this.pos, newline));
        this.pos = newline + 1;
        return line;
      }
      await this.fill();
    }
  }

  async readBytes(count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      if (this.pos >= this.buf.length) await this.fill();
      const take = Math.min(count - offset, this.buf.length - this.pos);
      out.set(this.buf.subarray(this.pos, this.pos + take), offset);
      offset += take;
      this.pos += take;
    }
    return out;
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.stream.read();
    if (done || !value) throw new Error("git cat-file exited unexpectedly");
    if (this.pos < this.buf.length) {
      const rest = this.buf.subarray(this.pos);
      const merged = new Uint8Array(rest.length + value.length);
      merged.set(rest);
      merged.set(value, rest.length);
      this.buf = merged;
    } else {
      this.buf = value;
    }
    this.pos = 0;
  }
}
