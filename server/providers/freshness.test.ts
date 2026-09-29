import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'so-freshness-'));
  process.env.DATA_DIR = dir;
  return dir;
});

import { cachePlayers, getCachedPlayers, getProviderCache, putProviderCache } from '../db.js';
import { sleeperApi } from '../services/sleeper.js';
import { loadEspnNews } from './news.js';
import { STALE_FALLBACK_DETAIL, VOLATILE_MAX_AGE_MS } from './freshness.js';
import { easternToIso } from '../utils/time.js';
import type { SleeperPlayer } from '../../shared/types.js';

const player = (injury: string | null): Record<string, SleeperPlayer> => ({ hall: { player_id: 'hall', full_name: 'Breece Hall', team: 'NYJ', position: 'RB', active: true, injury_status: injury } });

beforeAll(() => { expect(process.env.DATA_DIR).toBe(tmp); });
afterEach(() => vi.unstubAllGlobals());

describe('volatile data is never served from a fresh-looking cache', () => {
  it('a max age of 0 never hits, even for a row written a moment ago', () => {
    expect(VOLATILE_MAX_AGE_MS).toBe(0);
    putProviderCache('test', 'k', { a: 1 });
    expect(getProviderCache('test', 'k', VOLATILE_MAX_AGE_MS)).toBeNull();
    expect(getProviderCache('test', 'k', Infinity)?.value).toEqual({ a: 1 });
    cachePlayers(player('Out'));
    expect(getCachedPlayers(VOLATILE_MAX_AGE_MS)).toBeNull();
  });

  it('stale Sleeper injury data (Out) is replaced by the fresh catalog (Active) on the next run', async () => {
    cachePlayers(player('Out'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(player(null)), { status: 200 })));
    const result = await sleeperApi.getPlayers();
    expect(result.stale).toBe(false);
    expect(result.players.hall.injury_status).toBeNull();
    expect(getCachedPlayers(Infinity)?.hall.injury_status).toBeNull();
  });

  it('when the live refresh fails, the cached copy is returned but explicitly flagged stale', async () => {
    cachePlayers(player('Out'));
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await sleeperApi.getPlayers();
    expect(result.stale).toBe(true);
    expect(result.players.hall.injury_status).toBe('Out');
  });

  it('news is re-fetched every run, and an outage falls back to a flagged stale copy', async () => {
    const article = (headline: string) => ({ articles: [{ headline, categories: [{ type: 'athlete', athleteId: 1 }], published: '2026-09-29T10:00:00Z' }] });
    putProviderCache('news', 'news', [{ headline: 'old cached headline', categories: [{ type: 'athlete', athleteId: 1 }] }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(article('fresh headline')), { status: 200 })));
    const fresh = await loadEspnNews(false);
    expect(fresh.outcome.stale).toBeUndefined();
    expect(fresh.byAthleteId.get(1)?.[0].headline).toBe('fresh headline');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const fallback = await loadEspnNews(false);
    expect(fallback.outcome.stale).toBe(true);
    expect(fallback.outcome.detail).toBe(STALE_FALLBACK_DETAIL);
    expect(fallback.byAthleteId.get(1)?.[0].headline).toBe('fresh headline');
  });
});

describe('kickoff times', () => {
  it('converts nflverse Eastern wall-clock kickoffs to the true UTC instant, across DST', () => {
    expect(easternToIso('2026-09-27', '13:00')).toBe('2026-09-27T17:00:00.000Z');
    expect(easternToIso('2026-12-06', '13:00')).toBe('2026-12-06T18:00:00.000Z');
    expect(easternToIso('2026-09-27', 'nope')).toBeNull();
  });
});
