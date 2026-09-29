import type { SleeperLeague, SleeperMatchup, SleeperPlayer, SleeperRoster, SleeperState, SleeperUser } from '../../shared/types.js';
import { cachePlayers, getCachedPlayers, getSleeperCacheInfo, getStalePlayers } from '../db.js';
import { VOLATILE_MAX_AGE_MS } from '../providers/freshness.js';

const BASE_URL = 'https://api.sleeper.app/v1';

export class UpstreamError extends Error {
  constructor(public service: string, public status: number, message: string) { super(message); }
}

async function request<T>(path: string, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${path}`, { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'SleeperOptimizer/1.0' } });
    if (!response.ok) throw new UpstreamError('Sleeper', response.status, `Sleeper returned HTTP ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('Sleeper', 503, error instanceof Error ? error.message : 'Sleeper request failed');
  } finally { clearTimeout(timer); }
}

export class SleeperApi {
  getState() { return request<SleeperState>('/state/nfl'); }
  getUser(usernameOrId: string) { return request<SleeperUser | null>(`/user/${encodeURIComponent(usernameOrId)}`); }
  getUserLeagues(userId: string, season: string) { return request<SleeperLeague[]>(`/user/${encodeURIComponent(userId)}/leagues/nfl/${encodeURIComponent(season)}`); }
  getLeague(leagueId: string) { return request<SleeperLeague>(`/league/${encodeURIComponent(leagueId)}`); }
  getLeagueUsers(leagueId: string) { return request<SleeperUser[]>(`/league/${encodeURIComponent(leagueId)}/users`); }
  getRosters(leagueId: string) { return request<SleeperRoster[]>(`/league/${encodeURIComponent(leagueId)}/rosters`); }
  getMatchups(leagueId: string, week: number) { return request<SleeperMatchup[]>(`/league/${encodeURIComponent(leagueId)}/matchups/${week}`); }
  getTransactions(leagueId: string, week: number) { return request<unknown[]>(`/league/${encodeURIComponent(leagueId)}/transactions/${week}`); }

  /** The catalog carries live injury status, so by default it is re-fetched every run; a cached copy is only a flagged fallback. */
  async getPlayers(maxAgeMs = VOLATILE_MAX_AGE_MS): Promise<{ players: Record<string, SleeperPlayer>; stale: boolean; retrievedAt: string | null }> {
    const cached = getCachedPlayers(maxAgeMs);
    if (cached) return { players: cached, stale: false, retrievedAt: getSleeperCacheInfo().fetchedAt };
    try {
      const players = await request<Record<string, SleeperPlayer>>('/players/nfl', 45_000);
      cachePlayers(players);
      return { players, stale: false, retrievedAt: getSleeperCacheInfo().fetchedAt };
    } catch (error) {
      const stale = getStalePlayers();
      if (stale) return { players: stale, stale: true, retrievedAt: getSleeperCacheInfo().fetchedAt };
      throw error;
    }
  }
}

export const sleeperApi = new SleeperApi();
