import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary directory that owns every file a job creates.
 *
 * Making the directory the unit of cleanup means no individual file can be
 * forgotten: source audio, chunks and any ffmpeg leftovers all disappear with
 * one recursive remove, on success and on failure alike.
 */
export class Workspace {
  private disposed = false;

  private constructor(readonly root: string) {}

  static async create(prefix = "podcast-"): Promise<Workspace> {
    return new Workspace(await mkdtemp(join(tmpdir(), prefix)));
  }

  path(...segments: string[]): string {
    return join(this.root, ...segments);
  }

  /** Idempotent, so it is safe in a `finally` that may run after an earlier dispose. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await rm(this.root, { recursive: true, force: true });
  }
}

/** Run `work` with a workspace that is always removed, however `work` ends. */
export async function withWorkspace<T>(work: (workspace: Workspace) => Promise<T>): Promise<T> {
  const workspace = await Workspace.create();
  try {
    return await work(workspace);
  } finally {
    await workspace.dispose();
  }
}
