import type { NewsItem } from '../../shared/types.js';
import { getProviderCache, putProviderCache } from '../db.js';
import { STALE_FALLBACK_DETAIL, VOLATILE_MAX_AGE_MS } from './freshness.js';
import type { SourceOutcome } from './types.js';

const ESPN_SOURCE = 'ESPN NFL News';
const ROTOBALLER_SOURCE = 'RotoBaller';
const NEWS_TTL = VOLATILE_MAX_AGE_MS;

interface EspnCategory { type: string; athleteId?: number }
interface EspnArticle { headline: string; description?: string; published?: string; categories?: EspnCategory[]; links?: { web?: { href?: string } } }

async function fetchJson<T>(name: string, kind: SourceOutcome['kind'], url: string, cacheKey: string, forceRefresh: boolean, parse: (body: unknown) => T): Promise<{ value: T; outcome: SourceOutcome }> {
  if (!forceRefresh) {
    const hit = getProviderCache<T>('news', cacheKey, NEWS_TTL);
    if (hit) return { value: hit.value, outcome: { name, kind, status: 'SUCCESS', retrievedAt: hit.retrievedAt } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json, application/rss+xml, text/xml', 'user-agent': 'SleeperOptimizer/1.0 (+read-only fantasy football research tool)' } });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    const raw = url.includes('rss') || url.endsWith('/feed') ? await response.text() : await response.json();
    const value = parse(raw);
    const retrievedAt = putProviderCache('news', cacheKey, value);
    return { value, outcome: { name, kind, status: 'SUCCESS', retrievedAt } };
  } catch (error) {
    const stale = getProviderCache<T>('news', cacheKey, Infinity);
    if (stale) return { value: stale.value, outcome: { name, kind, status: 'SUCCESS', detail: STALE_FALLBACK_DETAIL, retrievedAt: stale.retrievedAt, stale: true } };
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return { value: (Array.isArray([]) ? [] : null) as T, outcome: { name, kind, status: timedOut ? 'TIMEOUT' : 'FAILED', detail: error instanceof Error ? error.message : String(error), retrievedAt: null } };
  } finally { clearTimeout(timer); }
}

export interface EspnNewsResult { byAthleteId: Map<number, NewsItem[]>; outcome: SourceOutcome }

export async function loadEspnNews(forceRefresh: boolean): Promise<EspnNewsResult> {
  const { value, outcome } = await fetchJson<EspnArticle[]>(
    ESPN_SOURCE, 'news', 'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50', 'espn', forceRefresh,
    body => ((body as { articles?: EspnArticle[] })?.articles || [])
  );
  const byAthleteId = new Map<number, NewsItem[]>();
  for (const article of value || []) {
    const athletes = (article.categories || []).filter(category => category.type === 'athlete' && category.athleteId != null);
    if (!athletes.length) continue;
    const item: NewsItem = { source: ESPN_SOURCE, headline: article.headline, summary: article.description || null, url: article.links?.web?.href || null, publishedAt: article.published || null };
    for (const athlete of athletes) byAthleteId.set(athlete.athleteId!, [...(byAthleteId.get(athlete.athleteId!) || []), item]);
  }
  return { byAthleteId, outcome };
}

export interface RotoBallerNewsResult { items: NewsItem[]; outcome: SourceOutcome }

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026' };

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}

const cleanText = (raw: string): string => decodeEntities(raw.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseRss(xml: string): NewsItem[] {
  const items: NewsItem[] = [];
  const blocks = xml.split('<item>').slice(1);
  for (const block of blocks.slice(0, 40)) {
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/.exec(block)?.[1]?.trim();
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1]?.trim();
    const descriptionRaw = /<description>([\s\S]*?)<\/description>/.exec(block)?.[1];
    const headline = title ? cleanText(title) : '';
    if (!headline) continue;
    const parsedDate = pubDate ? Date.parse(pubDate) : NaN;
    items.push({
      source: ROTOBALLER_SOURCE, headline, summary: descriptionRaw ? cleanText(descriptionRaw).slice(0, 240) || null : null,
      url: link || null, publishedAt: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : null
    });
  }
  return items;
}

export async function loadRotoBallerNews(forceRefresh: boolean): Promise<RotoBallerNewsResult> {
  const { value, outcome } = await fetchJson<NewsItem[]>(ROTOBALLER_SOURCE, 'news', 'https://www.rotoballer.com/feed', 'rotoballer', forceRefresh, body => parseRss(String(body)));
  return { items: value || [], outcome };
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches news items to players by whole-word full name (RSS feeds carry no athlete ids). Names shared by more than one
 * relevant player (two "Josh Allen"s) are skipped rather than guessed, and a name embedded inside a longer name is not a match.
 */
export function matchNewsByName(items: NewsItem[], players: Array<{ sleeperId: string; name: string }>): Map<string, NewsItem[]> {
  const result = new Map<string, NewsItem[]>();
  const nameCounts = new Map<string, number>();
  for (const player of players) { const key = player.name.trim().toLowerCase(); nameCounts.set(key, (nameCounts.get(key) || 0) + 1); }
  const candidates = players
    .filter(player => player.name.trim().includes(' ') && nameCounts.get(player.name.trim().toLowerCase()) === 1)
    .map(player => ({ sleeperId: player.sleeperId, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(player.name.trim())}(?![\\p{L}\\p{N}])`, 'iu') }));
  for (const item of items) {
    const text = `${item.headline} ${item.summary || ''}`;
    for (const candidate of candidates) {
      if (candidate.pattern.test(text)) result.set(candidate.sleeperId, [...(result.get(candidate.sleeperId) || []), item]);
    }
  }
  return result;
}
