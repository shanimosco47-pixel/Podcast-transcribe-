import {
  decodeXmlEntities,
  extractEnclosureUrlFromItem,
  extractFeedItems,
  extractItemDurationSeconds,
  extractItemPubDate,
  extractItemTitle,
  extractItemTranscriptUrl,
} from "../vendor/summarize/rss-feed.js";
import type { EpisodeCandidate } from "./types.js";

export interface FeedEpisode extends EpisodeCandidate {
  /** Podcasting 2.0 transcript, when the feed publishes one for this episode. */
  transcript: { url: string; type: string } | null;
}

/** Channel-level `<title>`, read before the first `<item>` so item titles cannot win. */
export function extractChannelTitle(feedXml: string): string | null {
  const head = feedXml.split(/<item\b/i)[0] ?? feedXml;
  const match = head.match(/<title>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const raw = match[1]
    .replaceAll(/<!\[CDATA\[/gi, "")
    .replaceAll(/\]\]>/g, "")
    .trim();
  return raw.length > 0 ? decodeXmlEntities(raw) : null;
}

/**
 * Every episode in the feed, as match candidates. Items with no title are
 * dropped: they cannot be matched, and keeping them would only add noise.
 */
export function feedEpisodes(feedXml: string): FeedEpisode[] {
  const showTitle = extractChannelTitle(feedXml);

  return extractFeedItems(feedXml).flatMap((item, index) => {
    const title = extractItemTitle(item);
    if (!title) return [];
    const enclosureUrl = extractEnclosureUrlFromItem(item);

    return [
      {
        id: `item-${index}`,
        title: decodeXmlEntities(title),
        showTitle,
        publishedAt: extractItemPubDate(item),
        durationSeconds: extractItemDurationSeconds(item),
        enclosureUrl: enclosureUrl ? decodeXmlEntities(enclosureUrl) : null,
        transcript: extractItemTranscriptUrl(item),
      },
    ];
  });
}
