import { getProviderCache, pruneLegacyNflverseCache, putProviderCache } from '../db.js';
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
export interface WeeklyStatRow { season: string; week: string; player_id: string; player_name: string; player_display_name?: string; position: string; fantasy_points?: string; fantasy_points_ppr?: string; carries?: string; targets?: string }

interface CachedCsv<T> { v: 2; lastModified: string | null; rows: T[] }

/** Keeps only the columns the app reads (and optionally reduces rows), so the SQLite provider cache stays small. */
interface CsvShape<T> { columns: Array<keyof T & string>; reduce?: (rows: Array<Record<string, string>>) => Array<Record<string, string>> }

function project<T>(rows: Array<Record<string, string>>, shape: CsvShape<T>): T[] {
  const reduced = shape.reduce ? shape.reduce(rows) : rows;
  return reduced.map(row => Object.fromEntries(shape.columns.map(column => [column, row[column] ?? '']))) as unknown as T[];
}

/** nflverse `last-modified` is the asset's own publication time — the only trustworthy source timestamp these CSVs expose. */
function headerTimestamp(value: string | null): string | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Latest depth-chart snapshot per player (the file stores every daily snapshot, ~600k rows). Ties keep the first row, as before. */
export function latestDepthSnapshot(rows: Array<Record<string, string>>): Array<Record<string, string>> {
  const latest = new Map<string, Record<string, string>>();
  for (const row of rows) {
    if (!row.gsis_id) continue;
    const held = latest.get(row.gsis_id);
    if (!held || row.dt > held.dt) latest.set(row.gsis_id, row);
  }
  return [...latest.values()];
}

async function fetchCsvAsset<T>(name: string, kind: SourceOutcome['kind'], path: string, ttlMs: number, forceRefresh: boolean, shape: CsvShape<T>): Promise<{ rows: T[]; outcome: SourceOutcome }> {
  const cacheKey = `${path}#v2`;
  if (!forceRefresh) {
    const hit = getProviderCache<CachedCsv<T>>('nflverse', cacheKey, ttlMs);
    if (hit) return { rows: hit.value.rows, outcome: { name, kind, status: 'SUCCESS', retrievedAt: hit.retrievedAt, sourceUpdatedAt: hit.value.lastModified } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${BASE}/${path}`, { signal: controller.signal, headers: { accept: 'text/csv', 'user-agent': 'SleeperOptimizer/1.0 (+read-only fantasy football research tool)' } });
    if (!response.ok) throw new Error(`nflverse ${path} returned HTTP ${response.status}`);
    const lastModified = headerTimestamp(response.headers.get('last-modified'));
    const rows = project(parseCsv(await response.text()), shape);
    const retrievedAt = putProviderCache('nflverse', cacheKey, { v: 2, lastModified, rows } satisfies CachedCsv<T>);
    return { rows, outcome: { name, kind, status: 'SUCCESS', retrievedAt, sourceUpdatedAt: lastModified } };
  } catch (error) {
    const stale = getProviderCache<CachedCsv<T>>('nflverse', cacheKey, Infinity);
    if (stale) return { rows: stale.value.rows, outcome: { name, kind, status: 'SUCCESS', detail: STALE_FALLBACK_DETAIL, retrievedAt: stale.retrievedAt, sourceUpdatedAt: stale.value.lastModified, stale: true } };
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
  try { pruneLegacyNflverseCache(); } catch { /* housekeeping only */ }
  const [games, depthCharts, injuries, snapCounts, weeklyStats] = await Promise.all([
    fetchCsvAsset<GameRow>('nflverse schedules', 'schedule', 'schedules/games.csv', SCHEDULE_TTL, forceRefresh, {
      columns: ['game_id', 'season', 'week', 'gameday', 'gametime', 'home_team', 'away_team', 'spread_line', 'total_line', 'roof']
    }),
    fetchCsvAsset<DepthChartRow>('nflverse depth charts', 'supporting', `depth_charts/depth_charts_${season}.csv`, DEPTH_CHART_TTL, forceRefresh, {
      columns: ['team', 'player_name', 'espn_id', 'gsis_id', 'pos_abb', 'pos_rank', 'dt'], reduce: latestDepthSnapshot
    }),
    fetchCsvAsset<InjuryRow>('nflverse injuries', 'injury', `injuries/injuries_${season}.csv`, INJURY_TTL, forceRefresh, {
      columns: ['season', 'week', 'team', 'gsis_id', 'full_name', 'report_status', 'report_primary_injury', 'practice_status']
    }),
    fetchCsvAsset<SnapCountRow>('nflverse snap counts', 'supporting', `snap_counts/snap_counts_${season}.csv`, SNAP_COUNT_TTL, forceRefresh, {
      columns: ['season', 'week', 'player', 'team', 'position', 'offense_snaps', 'offense_pct']
    }),
    fetchCsvAsset<WeeklyStatRow>('nflverse weekly stats', 'supporting', `stats_player/stats_player_week_${season}.csv`, WEEKLY_STATS_TTL, forceRefresh, {
      columns: ['season', 'week', 'player_id', 'player_name', 'position', 'fantasy_points', 'fantasy_points_ppr', 'carries', 'targets']
    })
  ]);
  return {
    games: games.rows, depthCharts: depthCharts.rows, injuries: injuries.rows, snapCounts: snapCounts.rows, weeklyStats: weeklyStats.rows,
    outcomes: [games.outcome, depthCharts.outcome, injuries.outcome, snapCounts.outcome, weeklyStats.outcome]
  };
}
