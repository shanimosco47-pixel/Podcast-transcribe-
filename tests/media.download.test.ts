import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { downloadAudio } from "../src/media/download.js";
import { withWorkspace, Workspace } from "../src/media/workspace.js";

const PUBLIC_DNS = () => Promise.resolve(["93.184.216.34"]);
const URL_UNDER_TEST = "https://cdn.example.com/audio/episode.mp3";

function respondWith(body: BodyInit, headers: Record<string, string> = {}) {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== URL_UNDER_TEST) return Promise.reject(new Error(`Unexpected request to ${url}`));
    return Promise.resolve(new Response(body, { status: 200, headers }));
  }) as typeof fetch;
}

/** A body that yields some bytes and then fails, simulating a dropped connection. */
function failingStream(prefixBytes: number): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(prefixBytes).fill(65));
        return;
      }
      controller.error(new Error("connection reset"));
    },
  });
}

describe("downloadAudio", () => {
  it("streams the enclosure into the workspace", async () => {
    await withWorkspace(async (workspace) => {
      const audio = await downloadAudio(URL_UNDER_TEST, workspace, {
        fetch: respondWith("fake-mp3-bytes"),
        resolveHost: PUBLIC_DNS,
      });

      expect(audio.bytes).toBe("fake-mp3-bytes".length);
      expect(await readFile(audio.path, "utf8")).toBe("fake-mp3-bytes");
      expect(audio.path.startsWith(workspace.root)).toBe(true);
    });
  });

  it("aborts an oversized download and leaves no partial file", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        downloadAudio(
          URL_UNDER_TEST,
          workspace,
          { fetch: respondWith("z".repeat(5000)), resolveHost: PUBLIC_DNS },
          { maxBytes: 500 },
        ),
      ).rejects.toMatchObject({ reason: "response_too_large" });

      expect(await readdir(workspace.root)).toEqual([]);
    });
  });

  it("refuses before writing when the declared length is over the cap", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        downloadAudio(
          URL_UNDER_TEST,
          workspace,
          {
            fetch: respondWith("z".repeat(50), { "content-length": "99999999" }),
            resolveHost: PUBLIC_DNS,
          },
          { maxBytes: 1000 },
        ),
      ).rejects.toMatchObject({ reason: "response_too_large" });

      expect(await readdir(workspace.root)).toEqual([]);
    });
  });

  it("removes the partial file when the connection drops mid-download", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        downloadAudio(URL_UNDER_TEST, workspace, {
          fetch: respondWith(failingStream(1024)),
          resolveHost: PUBLIC_DNS,
        }),
      ).rejects.toThrow(/connection reset/);

      expect(await readdir(workspace.root)).toEqual([]);
    });
  });

  it("applies the SSRF guard to the enclosure URL", async () => {
    await withWorkspace(async (workspace) => {
      await expect(
        downloadAudio("http://169.254.169.254/latest/meta-data/", workspace, {
          fetch: respondWith("secret"),
          resolveHost: PUBLIC_DNS,
        }),
      ).rejects.toMatchObject({ reason: "blocked_host" });
    });
  });
});

describe("Workspace cleanup", () => {
  it("removes the directory and everything in it after success", async () => {
    let root = "";
    await withWorkspace(async (workspace) => {
      root = workspace.root;
      await downloadAudio(URL_UNDER_TEST, workspace, {
        fetch: respondWith("bytes"),
        resolveHost: PUBLIC_DNS,
      });
      expect(existsSync(workspace.root)).toBe(true);
    });
    expect(existsSync(root)).toBe(false);
  });

  it("removes the directory after a failure inside the job", async () => {
    let root = "";
    await expect(
      withWorkspace(async (workspace) => {
        root = workspace.root;
        await downloadAudio(URL_UNDER_TEST, workspace, {
          fetch: respondWith("bytes"),
          resolveHost: PUBLIC_DNS,
        });
        throw new Error("injected failure after download");
      }),
    ).rejects.toThrow(/injected failure/);

    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  it("is safe to dispose twice", async () => {
    const workspace = await Workspace.create();
    await workspace.dispose();
    await expect(workspace.dispose()).resolves.toBeUndefined();
  });
});
