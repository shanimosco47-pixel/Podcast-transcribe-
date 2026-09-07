import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedTranscription {
  model: string | null;
  language: string | null;
  fileName: string | null;
  authorization: string | null;
  bodyBytes: number;
}

export interface RecordedSummary {
  model: string | null;
  authorization: string | null;
  transcript: string;
}

export interface MockProvider {
  baseUrl: string;
  transcriptions: RecordedTranscription[];
  summaries: RecordedSummary[];
  close(): Promise<void>;
}

export interface MockProviderOptions {
  /** Text returned per call, in call order. Falls back to a generic line. */
  transcriptFor?: (call: number) => string;
  summary?: { summary: string; keyPoints: string[] };
  /** Build a summary from what the model was actually sent, for flow tests. */
  summaryFor?: (userContent: string, call: number) => { summary: string; keyPoints: string[] };
  /** Force a failure status on one endpoint. */
  failTranscription?: number;
  failSummary?: number;
  /**
   * Body returned with a forced failure. Used to prove a hostile provider
   * cannot push its content into anything the user or a log sees.
   */
  errorBody?: string;
}

/** Pull a multipart field value out of a raw body without a parser dependency. */
function multipartField(body: string, name: string): string | null {
  const pattern = new RegExp(
    `name="${name}"\\r?\\n\\r?\\n([\\s\\S]*?)\\r?\\n--`,
    "i",
  );
  return body.match(pattern)?.[1]?.trim() ?? null;
}

function multipartFileName(body: string): string | null {
  return body.match(/name="file";\s*filename="([^"]*)"/i)?.[1] ?? null;
}

/**
 * A local stand-in for an OpenAI-compatible provider.
 *
 * Exists so the production adapters can be exercised for real — request shape,
 * headers, ordering, error handling — without a paid service or credentials.
 */
export async function startMockProvider(options: MockProviderOptions = {}): Promise<MockProvider> {
  const transcriptions: RecordedTranscription[] = [];
  const summaries: RecordedSummary[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString("utf8");
      const authorization = req.headers.authorization ?? null;

      if (req.url?.endsWith("/audio/transcriptions")) {
        transcriptions.push({
          model: multipartField(body, "model"),
          language: multipartField(body, "language"),
          fileName: multipartFileName(body),
          authorization,
          bodyBytes: raw.byteLength,
        });

        if (options.failTranscription) {
          res.writeHead(options.failTranscription, { "content-type": "application/json" });
          res.end(options.errorBody ?? JSON.stringify({ error: { message: "provider is unhappy" } }));
          return;
        }

        const call = transcriptions.length - 1;
        const text = options.transcriptFor?.(call) ?? `קטע ${call}`;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text }));
        return;
      }

      if (req.url?.endsWith("/chat/completions")) {
        const parsed = JSON.parse(body) as {
          model?: string;
          messages?: { role: string; content: string }[];
        };
        summaries.push({
          model: parsed.model ?? null,
          authorization,
          transcript: parsed.messages?.find((m) => m.role === "user")?.content ?? "",
        });

        if (options.failSummary) {
          res.writeHead(options.failSummary, { "content-type": "application/json" });
          res.end(options.errorBody ?? JSON.stringify({ error: { message: "summary provider is unhappy" } }));
          return;
        }

        const userContent = summaries[summaries.length - 1]?.transcript ?? "";
        const summary =
          options.summaryFor?.(userContent, summaries.length - 1) ??
          options.summary ?? {
            summary: "סיכום קצר בעברית.",
            keyPoints: ["נקודה ראשונה", "נקודה שנייה"],
          };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(summary) } }] }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    transcriptions,
    summaries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
