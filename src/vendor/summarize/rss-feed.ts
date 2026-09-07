/**
 * RSS/Atom feed parsing vendored from steipete/summarize (MIT).
 * See NOTICE.md for provenance and for what was deliberately left behind.
 */

export function looksLikeRssOrAtomFeed(xml: string): boolean {
  const head = xml.slice(0, 4096).trimStart().toLowerCase();
  if (head.includes("<rss")) return true;
  if (head.startsWith("<?xml") && (head.includes("<rss") || head.includes("<feed"))) return true;
  return head.includes("<feed");
}

export function extractFeedItems(xml: string): string[] {
  return xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
}

function stripCdata(value: string): string {
  return value
    .replaceAll(/<!\[CDATA\[/gi, "")
    .replaceAll(/\]\]>/g, "")
    .trim();
}

export function extractItemTitle(itemXml: string): string | null {
  const match = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const raw = stripCdata(match[1]);
  return raw.length > 0 ? raw : null;
}

export function extractEnclosureUrlFromItem(xml: string): string | null {
  const enclosureMatch = xml.match(/<enclosure\b[^>]*\burl\s*=\s*(['"])([^'"]+)\1/i);
  if (enclosureMatch?.[2]) return enclosureMatch[2];

  const atomMatch = xml.match(
    /<link\b[^>]*\brel\s*=\s*(['"])enclosure\1[^>]*\bhref\s*=\s*(['"])([^'"]+)\2/i,
  );
  return atomMatch?.[3] ?? null;
}

export function extractItemDurationSeconds(itemXml: string): number | null {
  const match = itemXml.match(/<itunes:duration>([\s\S]*?)<\/itunes:duration>/i);
  if (!match?.[1]) return null;
  const raw = stripCdata(match[1]);
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  const parts = raw.split(":").map((value) => value.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((value) => !/^\d+$/.test(value))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;

  if (nums.length === 3) {
    const [hours, minutes, seconds] = nums as [number, number, number];
    if (minutes >= 60 || seconds >= 60) return null;
    const total = Math.round(hours * 3600 + minutes * 60 + seconds);
    return total > 0 ? total : null;
  }
  const [minutes, seconds] = nums as [number, number];
  if (seconds >= 60) return null;
  const total = Math.round(minutes * 60 + seconds);
  return total > 0 ? total : null;
}

export function decodeXmlEntities(value: string): string {
  return value
    .replaceAll(/&amp;/gi, "&")
    .replaceAll(/&#38;/g, "&")
    .replaceAll(/&lt;/gi, "<")
    .replaceAll(/&gt;/gi, ">")
    .replaceAll(/&quot;/gi, '"')
    .replaceAll(/&apos;/gi, "'");
}

/** Not upstream: upstream never read pubDate, which the issue requires as a match signal. */
export function extractItemPubDate(itemXml: string): string | null {
  const match = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
  if (!match?.[1]) return null;
  const raw = stripCdata(match[1]);
  return raw.length > 0 ? raw : null;
}

/** Not upstream: Podcasting 2.0 transcript, preferred over transcribing audio. */
export function extractItemTranscriptUrl(itemXml: string): { url: string; type: string } | null {
  const match = itemXml.match(/<podcast:transcript\b[^>]*>/i);
  if (!match?.[0]) return null;
  const tag = match[0];
  const url = tag.match(/\burl\s*=\s*(['"])([^'"]+)\1/i)?.[2];
  if (!url) return null;
  const type = tag.match(/\btype\s*=\s*(['"])([^'"]+)\1/i)?.[2] ?? "text/plain";
  return { url: decodeXmlEntities(url), type };
}
