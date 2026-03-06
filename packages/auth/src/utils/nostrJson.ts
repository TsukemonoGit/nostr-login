// ─── NostrJson fetch with cache ─────────────────────────────────────

const nostrJsonCache: Map<string, { data: any; timestamp: number }> = new Map();
const NOSTR_JSON_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const NOSTR_JSON_FETCH_TIMEOUT = 5000; // 5 seconds

export async function fetchNostrJson(domain: string): Promise<any> {
  const cached = nostrJsonCache.get(domain);
  if (cached && Date.now() - cached.timestamp < NOSTR_JSON_CACHE_TTL) {
    return cached.data;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOSTR_JSON_FETCH_TIMEOUT);
  try {
    const info = await (await fetch(`https://${domain}/.well-known/nostr.json`, { signal: controller.signal })).json();
    nostrJsonCache.set(domain, { data: info, timestamp: Date.now() });
    return info;
  } finally {
    clearTimeout(timer);
  }
}
