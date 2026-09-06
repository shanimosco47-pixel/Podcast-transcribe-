import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

export interface FixtureRoute {
  body: string;
  status?: number;
  contentType?: string;
}

/**
 * A `fetch` backed by recorded responses. Any URL not in the map rejects, so a
 * test can never silently reach the network.
 */
export function fixtureFetch(routes: Record<string, FixtureRoute>): {
  fetch: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];

  const impl = ((input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    const route = routes[url];
    if (!route) return Promise.reject(new Error(`No fixture recorded for ${url}`));
    return Promise.resolve(
      new Response(route.body, {
        status: route.status ?? 200,
        headers: { "content-type": route.contentType ?? "text/plain; charset=utf-8" },
      }),
    );
  }) as typeof fetch;

  return { fetch: impl, requested };
}
