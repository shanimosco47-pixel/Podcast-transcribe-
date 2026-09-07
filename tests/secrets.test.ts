import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Files git actually tracks, so the check cannot be fooled by ignored scratch files. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
];

describe("no secrets in tracked files", () => {
  it("tracks no file matching a known credential shape", () => {
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      if (file.startsWith("docs/screenshots/") || file === "package-lock.json") continue;
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(content)) offenders.push(`${file}: ${name}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps .env out of version control", () => {
    const tracked = trackedFiles();
    expect(tracked.filter((file) => /(^|\/)\.env$/.test(file))).toEqual([]);
    expect(tracked).toContain(".env.example");
  });

  it("documents required secrets by name with no values", () => {
    const example = readFileSync(".env.example", "utf8");
    expect(example).toContain("TRANSCRIPTION_API_KEY=");
    for (const line of example.split("\n")) {
      if (!line.trim() || line.trimStart().startsWith("#")) continue;
      expect(line.split("=")[1] ?? "").toBe("");
    }
  });
});
