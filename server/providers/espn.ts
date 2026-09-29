import type { NewsItem, ProjectionValue, RankingValue, SupportingDataPoint } from '../../shared/types.js';
import { getProviderCache, putProviderCache } from '../db.js';
import { scoreEspnProjection, type EspnStatLine } from '../engine/scoring.js';
import { sleeperTeamCode } from '../services/player-mapping.js';
import { STALE_FALLBACK_DETAIL, VOLATILE_MAX_AGE_MS } from './freshness.js';
import type { ExternalPlayerData, SourceOutcome } from './types.js';

const SOURCE = 'ESPN Fantasy';
const TTL = VOLATILE_MAX_AGE_MS;

/** ESPN's numeric pro-team IDs, stable and widely documented across open-source ESPN fantasy libraries. */
const PRO_TEAM: Record<number, string> = {
  1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WAS', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU'
};
const POSITION: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

/** ESPN fantasy `slotId` for each position; ranks are only comparable within the player's own position slot. */
const POSITION_SLOT: Record<string, number> = { QB: 0, RB: 2, WR: 4, TE: 6, K: 17, DEF: 16 };

interface EspnStatEntry { scoringPeriodId: number; seasonId: number; statSourceId: number; statSplitTypeId?: number; stats?: Record<string, number> }
interface EspnRankEntry { rank: number; rankType: string; rankSourceId: number; slotId: number }
interface EspnPlayerRow {
  id: number;
  fullName?: string;
  proTeamId?: number;
  defaultPositionId?: number;
  injuryStatus?: string;
  ownership?: { percentOwned?: number; percentStarted?: number };
  stats?: EspnStatEntry[];
  rankings?: Record<string, EspnRankEntry[]>;
}

async function fetchPlayers(season: string, week: number, forceRefresh: boolean): Promise<{ rows: EspnPlayerRow[]; outcome: SourceOutcome }> {
  const cacheKey = `players:${season}:${week}`;
  if (!forceRefresh) {
    const hit = getProviderCache<EspnPlayerRow[]>('espn', cacheKey, TTL);
    if (hit) return { rows: hit.value, outcome: { name: SOURCE, kind: 'projection', status: 'SUCCESS', retrievedAt: hit.retrievedAt } };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/players?scoringPeriodId=${week}&view=kona_player_info`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'SleeperOptimizer/1.0 (+read-only fantasy football research tool)',
        'x-fantasy-filter': JSON.stringify({ players: { limit: 20000, sortPercOwned: { sortPriority: 1, sortAsc: false } } })
      }
    });
    if (!response.ok) throw new Error(`ESPN returned HTTP ${response.status}`);
    const rows = await response.json() as EspnPlayerRow[];
    if (!Array.isArray(rows) || !rows.length) throw new Error('ESPN returned an empty or unexpected player list');
    const retrievedAt = putProviderCache('espn', cacheKey, rows);
    return { rows, outcome: { name: SOURCE, kind: 'projection', status: 'SUCCESS', retrievedAt } };
  } catch (error) {
    const stale = getProviderCache<EspnPlayerRow[]>('espn', cacheKey, Infinity);
    if (stale) return { rows: stale.value, outcome: { name: SOURCE, kind: 'projection', status: 'SUCCESS', detail: STALE_FALLBACK_DETAIL, retrievedAt: stale.retrievedAt, stale: true } };
    const timedOut = error instanceof Error && error.name === 'AbortError';
    return { rows: [], outcome: { name: SOURCE, kind: 'projection', status: timedOut ? 'TIMEOUT' : 'BLOCKED', detail: error instanceof Error ? error.message : String(error), retrievedAt: null } };
  } finally { clearTimeout(timer); }
}

export interface EspnUnmatched { espnId: string; name: string; team: string | null; position: string; points: number }

export interface EspnResult {
  data: Map<string, ExternalPlayerData>;
  /** ESPN players that carry a real projection but could not be joined to any Sleeper player (a missed mapping, not a missing projection). */
  unmatchedProjected: EspnUnmatched[];
  rankings: Map<string, RankingValue[]>;
  news: Map<string, NewsItem[]>;
  outcome: SourceOutcome;
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** ESPN publishes one rank per expert (rankSourceId) per rank type and position slot; collapse to one source-level ranking. */
export function aggregateEspnRankings(entries: EspnRankEntry[], position: string, rankType: 'PPR' | 'STANDARD', week: number, retrievedAt: string | null, stale: boolean): RankingValue | null {
  const slot = POSITION_SLOT[position];
  if (slot == null) return null;
  const perExpert = new Map<number, number>();
  for (const entry of entries) if (entry.slotId === slot && entry.rankType === rankType && Number.isFinite(entry.rank) && entry.rank > 0) perExpert.set(entry.rankSourceId, entry.rank);
  if (!perExpert.size) return null;
  const ranks = [...perExpert.values()];
  return {
    source: `${SOURCE} expert rankings`, positionRank: Math.round(median(ranks)), overallRank: null, scoringType: rankType, retrievedAt, week,
    expertCount: ranks.length, rankMin: Math.min(...ranks), rankMax: Math.max(...ranks), ...(stale ? { stale: true } : {})
  };
}

/** The single ESPN entry that is a weekly projection: statSourceId 1 (projection; 0 is actual), single-period split, exact week and season. */
export function findWeeklyProjection(stats: EspnStatEntry[] | undefined, season: number, week: number): EspnStatEntry | undefined {
  return stats?.find(entry => entry.scoringPeriodId === week && entry.seasonId === season && entry.statSourceId === 1 && (entry.statSplitTypeId ?? 1) === 1);
}

export async function loadEspnProjections(
  season: string, week: number, scoring: Record<string, number>, espnIdToSleeperId: Map<string, string>, forceRefresh: boolean
): Promise<EspnResult> {
  const { rows, outcome } = await fetchPlayers(season, week, forceRefresh);
  const data = new Map<string, ExternalPlayerData>();
  const rankings = new Map<string, RankingValue[]>();
  const unmatchedProjected: EspnUnmatched[] = [];
  const scoringPpr = scoring.rec ?? 0;
  const rankType: 'PPR' | 'STANDARD' = scoringPpr > 0 ? 'PPR' : 'STANDARD';
  const stale = Boolean(outcome.stale);

  for (const row of rows) {
    const position = POSITION[row.defaultPositionId ?? -1];
    if (!position) continue;
    const team = PRO_TEAM[row.proTeamId ?? -1] || null;
    // Team defenses have no person-level identity in the crosswalk; Sleeper's own DEF player_id is the team code.
    const sleeperId = position === 'DEF' ? (team ? sleeperTeamCode(team) : null) : espnIdToSleeperId.get(String(row.id));
    const weeklyEntry = findWeeklyProjection(row.stats, Number(season), week);
    const scored = weeklyEntry ? scoreEspnProjection((weeklyEntry.stats || {}) as EspnStatLine, scoring, position) : null;
    if (!sleeperId) {
      if (scored?.points != null && team) unmatchedProjected.push({ espnId: String(row.id), name: row.fullName || String(row.id), team, position, points: scored.points });
      continue;
    }
    const missingReason = !weeklyEntry ? 'ESPN published no weekly projection entry for this player and week.' : scored?.points == null ? (scored?.reason || 'ESPN projection lacked the core statistics needed to score it.') : null;

    const ranking = aggregateEspnRankings(row.rankings?.[String(week)] || [], position, rankType, week, outcome.retrievedAt, stale);
    if (ranking) rankings.set(sleeperId, [ranking]);

    const supportingData: SupportingDataPoint[] = [];
    if (row.ownership?.percentOwned != null) supportingData.push({ label: 'ESPN ownership', value: `Rostered in ${row.ownership.percentOwned.toFixed(1)}% of ESPN leagues`, source: SOURCE });
    if (row.ownership?.percentStarted != null) supportingData.push({ label: 'ESPN start rate', value: `Started in ${row.ownership.percentStarted.toFixed(1)}% of ESPN lineups`, source: SOURCE });

    const projection: ProjectionValue | null = weeklyEntry && scored && scored.points != null ? {
      source: SOURCE, points: scored.points, scoringComponents: scored.components, unsupportedScoringKeys: scored.unsupportedKeys, coverage: scored.coverage,
      retrievedAt: outcome.retrievedAt, ...(stale ? { stale: true } : {}),
      provenance: {
        season: weeklyEntry.seasonId, week: weeklyEntry.scoringPeriodId, statSourceId: weeklyEntry.statSourceId, statSplitTypeId: weeklyEntry.statSplitTypeId ?? 1,
        providerPlayerId: String(row.id), providerPlayerName: row.fullName || null, rawStatLine: scored.statLine,
        omittedKeys: scored.omittedKeys, minorUnmodeledKeys: scored.minorUnmodeledKeys, approximations: scored.approximations
      }
    } : null;

    data.set(sleeperId, {
      sleeperId,
      externalPlayerId: String(row.id),
      weeklyPoints: projection?.points ?? null,
      restOfSeasonValue: null,
      injuryStatus: row.injuryStatus && row.injuryStatus !== 'ACTIVE' ? row.injuryStatus : null,
      opponent: null,
      gameTime: null,
      confidence: projection ? (projection.coverage! >= 80 ? 'High' : projection.coverage! >= 50 ? 'Medium' : 'Low') : 'Low',
      projectionCoverage: scored?.coverage ?? 0,
      scoringComponents: scored?.components ?? [],
      unsupportedScoringKeys: scored?.unsupportedKeys ?? [],
      missingReason,
      projections: projection ? [projection] : [],
      rankings: ranking ? [ranking] : [],
      supportingData,
      metrics: {
        projection: { value: projection?.points ?? null, source: SOURCE },
        coverage: { value: scored?.coverage ?? null, source: 'Sleeper scoring × ESPN statistics' },
        ownership: { value: row.ownership?.percentOwned ?? null, source: SOURCE }
      }
    });
  }
  return { data, unmatchedProjected, rankings, news: new Map(), outcome };
}
