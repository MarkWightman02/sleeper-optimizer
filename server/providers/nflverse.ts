import { getProviderCache, putProviderCache } from '../db.js';
import { parseCsv } from '../utils/csv.js';
import { STALE_FALLBACK_DETAIL, VOLATILE_MAX_AGE_MS } from './freshness.js';
import type { SourceOutcome } from './types.js';

const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SCHEDULE_TTL = VOLATILE_MAX_AGE_MS;
const DEPTH_CHART_TTL = VOLATILE_MAX_AGE_MS;
const INJURY_TTL = VOLATILE_MAX_AGE_MS;
const SNAP_COUNT_TTL = VOLATILE_MAX_AGE_MS;
const WEEKLY_STATS_TTL = VOLATILE_MAX_AGE_MS;

export interface GameRow {
  game_id: string; season: string; week: string; gameday: string; gametime: string;
  home_team: string; away_team: string; spread_line?: string; total_line?: string; roof?: string;
}
export interface DepthChartRow { team: string; player_name: string; espn_id: string; gsis_id: string; pos_abb: string; pos_rank: string; dt: string }
export interface InjuryRow { season: string; week: string; team: string; gsis_id: string; full_name: string; report_status: string; report_primary_injury: string; practice_status: string }
export interface SnapCountRow { season: string; week: string; player: string; pfr_player_id?: string; team: string; position: string; offense_snaps?: string; offense_pct?: string }
export interface WeeklyStatRow { season: string; week: string; player_id: string; player_name: string; player_display_name?: string; position: string; recent_team: string; fantasy_points?: string; fantasy_points_ppr?: string; carries?: string; targets?: string }

async function fetchCsvAsset<T>(name: string, kind: SourceOutcome['kind'], path: string, ttlMs: number, forceRefresh: boolean): Promise<{ rows: T[]; outcome: SourceOutcome }> {
  if (!forceRefresh) {
    const hit = getProviderCache<T[]>('nflverse', path, ttlMs);
    if (hit) return { rows: hit.value, outcome: { name, kind, status: 'SUCCESS', retrievedAt: hit.retrievedAt } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${BASE}/${path}`, { signal: controller.signal, headers: { accept: 'text/csv', 'user-agent': 'SleeperOptimizer/1.0 (+read-only fantasy football research tool)' } });
    if (!response.ok) throw new Error(`nflverse ${path} returned HTTP ${response.status}`);
    const text = await response.text();
    const rows = parseCsv(text) as unknown as T[];
    const retrievedAt = putProviderCache('nflverse', path, rows);
    return { rows, outcome: { name, kind, status: 'SUCCESS', retrievedAt } };
  } catch (error) {
    const stale = getProviderCache<T[]>('nflverse', path, Infinity);
    if (stale) return { rows: stale.value, outcome: { name, kind, status: 'SUCCESS', detail: STALE_FALLBACK_DETAIL, retrievedAt: stale.retrievedAt, stale: true } };
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return { rows: [], outcome: { name, kind, status: timedOut ? 'TIMEOUT' : 'FAILED', detail: error instanceof Error ? error.message : String(error), retrievedAt: null } };
  } finally { clearTimeout(timer); }
}

export interface NflverseBundle {
  games: GameRow[];
  depthCharts: DepthChartRow[];
  injuries: InjuryRow[];
  snapCounts: SnapCountRow[];
  weeklyStats: WeeklyStatRow[];
  outcomes: SourceOutcome[];
}

export async function loadNflverseBundle(season: string, forceRefresh = false): Promise<NflverseBundle> {
  const [games, depthCharts, injuries, snapCounts, weeklyStats] = await Promise.all([
    fetchCsvAsset<GameRow>('nflverse schedules', 'schedule', 'schedules/games.csv', SCHEDULE_TTL, forceRefresh),
    fetchCsvAsset<DepthChartRow>('nflverse depth charts', 'supporting', `depth_charts/depth_charts_${season}.csv`, DEPTH_CHART_TTL, forceRefresh),
    fetchCsvAsset<InjuryRow>('nflverse injuries', 'injury', `injuries/injuries_${season}.csv`, INJURY_TTL, forceRefresh),
    fetchCsvAsset<SnapCountRow>('nflverse snap counts', 'supporting', `snap_counts/snap_counts_${season}.csv`, SNAP_COUNT_TTL, forceRefresh),
    fetchCsvAsset<WeeklyStatRow>('nflverse weekly stats', 'supporting', `stats_player/stats_player_week_${season}.csv`, WEEKLY_STATS_TTL, forceRefresh)
  ]);
  return {
    games: games.rows, depthCharts: depthCharts.rows, injuries: injuries.rows, snapCounts: snapCounts.rows, weeklyStats: weeklyStats.rows,
    outcomes: [games.outcome, depthCharts.outcome, injuries.outcome, snapCounts.outcome, weeklyStats.outcome]
  };
}
