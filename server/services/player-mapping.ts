import type { MappingConfidence, MappingDiagnostic, SleeperPlayer } from '../../shared/types.js';
import { deletePlayerMapping, getPlayerMappings, upsertPlayerMapping } from '../db.js';
import type { CrosswalkIndex, CrosswalkRow } from './crosswalk.js';

export interface IdentityMatch {
  espnId: string | null;
  gsisId: string | null;
  method: string;
  confidence: MappingConfidence;
}

export interface MappingResult {
  bySleeperId: Map<string, IdentityMatch>;
  diagnostics: MappingDiagnostic[];
}

export function normalizePlayerName(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
}

/** Alternate NFL team codes → one internal code. The DynastyProcess crosswalk uses GBP/KCC/NEP-style codes for some players. */
const TEAM_ALIASES: Record<string, string> = {
  JAX: 'JAC', LA: 'LAR', STL: 'LAR', RAM: 'LAR', OAK: 'LV', LVR: 'LV', SD: 'LAC', SDG: 'LAC', WSH: 'WAS',
  GBP: 'GB', KCC: 'KC', NEP: 'NE', NOS: 'NO', SFO: 'SF', TBB: 'TB', ARZ: 'ARI', BLT: 'BAL', CLV: 'CLE', HST: 'HOU'
};

export function normalizeTeam(value?: string | null): string | null {
  if (!value) return null;
  const team = value.toUpperCase();
  return TEAM_ALIASES[team] || team;
}

/** Sleeper's own team code (JAX, LAR, LV…): used for display and for team-defense ids, which Sleeper keys by team code. */
export function sleeperTeamCode(value?: string | null): string | null {
  if (!value) return null;
  const team = value.toUpperCase();
  return ({ JAC: 'JAX', LA: 'LAR', STL: 'LAR', OAK: 'LV', SD: 'LAC', WSH: 'WAS' } as Record<string, string>)[team] || team;
}

export function normalizePosition(value?: string | null): string | null {
  if (!value) return null;
  const position = value.toUpperCase();
  if (position === 'DST' || position === 'D/ST') return 'DEF';
  if (position === 'PK') return 'K';
  if (['DE', 'DT'].includes(position)) return 'DL';
  if (['CB', 'S', 'FS', 'SS'].includes(position)) return 'DB';
  return position;
}

function positionsForSleeper(player: SleeperPlayer): string[] {
  return (player.fantasy_positions?.length ? player.fantasy_positions : player.position ? [player.position] : []).map(normalizePosition).filter((value): value is string => Boolean(value));
}

const RELEVANT_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB']);

/**
 * Resolves Sleeper player IDs to external identity (ESPN id, GSIS id) using, in order:
 * 1. the community-maintained crosswalk's own `sleeper_id` column (exact — the crosswalk maintainers already joined it),
 * 2. a persisted mapping from a prior run,
 * 3. Sleeper's own `gsis_id`/`espn_id` fields cross-matched against the crosswalk,
 * 4. normalized name+team+position, then name+position, against the crosswalk.
 * Ambiguous or unmatched players are reported in diagnostics rather than guessed.
 */
export function resolvePlayerIdentities(sleeperPlayers: Record<string, SleeperPlayer>, crosswalk: CrosswalkIndex): MappingResult {
  const result: MappingResult = { bySleeperId: new Map(), diagnostics: [] };
  const relevant = Object.entries(sleeperPlayers).filter(([, player]) => player.active !== false && positionsForSleeper(player).some(position => RELEVANT_POSITIONS.has(position)));

  const nameTeamIndex = new Map<string, CrosswalkRow[]>();
  const namePositionIndex = new Map<string, CrosswalkRow[]>();
  const allCrosswalkRows = new Set([...crosswalk.bySleeperId.values(), ...crosswalk.byGsisId.values(), ...crosswalk.byEspnId.values()]);
  for (const row of allCrosswalkRows) {
    const name = normalizePlayerName(row.name || row.merge_name || '');
    if (!name) continue;
    const position = normalizePosition(row.position);
    const team = normalizeTeam(row.team);
    if (team) { const key = `${name}|${team}|${position || ''}`; nameTeamIndex.set(key, [...(nameTeamIndex.get(key) || []), row]); }
    if (position) { const key = `${name}|${position}`; namePositionIndex.set(key, [...(namePositionIndex.get(key) || []), row]); }
  }

  const persisted = new Map(getPlayerMappings('espn').map(row => [row.sleeper_player_id, row]));
  const usedEspnIds = new Set<string>();

  const addMatch = (sleeperId: string, row: CrosswalkRow | null, method: string, confidence: MappingConfidence, sleeper: SleeperPlayer, persist: boolean) => {
    const espnId = row?.espn_id || null;
    const gsisId = row?.gsis_id || sleeper.gsis_id || null;
    result.bySleeperId.set(sleeperId, { espnId, gsisId, method, confidence });
    if (espnId) usedEspnIds.add(espnId);
    result.diagnostics.push({ sleeperPlayerId: sleeperId, externalPlayerId: espnId, name: sleeper.full_name || row?.name || sleeperId, team: normalizeTeam(sleeper.team), position: normalizePosition(sleeper.position), status: 'mapped', method, confidence });
    if (persist && espnId) upsertPlayerMapping({ provider: 'espn', sleeper_player_id: sleeperId, provider_player_id: espnId, match_method: method, confidence });
  };

  for (const [sleeperId, sleeper] of relevant) {
    if (positionsForSleeper(sleeper).includes('DEF')) {
      result.bySleeperId.set(sleeperId, { espnId: null, gsisId: null, method: 'team_code', confidence: 'exact' });
      result.diagnostics.push({ sleeperPlayerId: sleeperId, name: sleeper.full_name || sleeperId, team: normalizeTeam(sleeper.team), position: 'DEF', status: 'mapped', method: 'team_code', confidence: 'exact' });
      continue;
    }
    const direct = crosswalk.bySleeperId.get(sleeperId);
    if (direct) { addMatch(sleeperId, direct, 'crosswalk:sleeper_id', 'exact', sleeper, false); continue; }

    const remembered = persisted.get(sleeperId);
    if (remembered) {
      const row = crosswalk.byEspnId.get(remembered.provider_player_id) || null;
      if (row || remembered.confidence !== 'unmapped') { addMatch(sleeperId, row, `persisted:${remembered.match_method}`, remembered.confidence, sleeper, false); continue; }
      deletePlayerMapping('espn', sleeperId);
    }

    if (sleeper.gsis_id && crosswalk.byGsisId.has(sleeper.gsis_id)) { addMatch(sleeperId, crosswalk.byGsisId.get(sleeper.gsis_id)!, 'gsis_id', 'high', sleeper, true); continue; }
    if (sleeper.espn_id != null && crosswalk.byEspnId.has(String(sleeper.espn_id))) { addMatch(sleeperId, crosswalk.byEspnId.get(String(sleeper.espn_id))!, 'espn_id', 'high', sleeper, true); continue; }

    const name = normalizePlayerName(sleeper.full_name || `${sleeper.first_name || ''} ${sleeper.last_name || ''}`);
    const team = normalizeTeam(sleeper.team);
    const positions = positionsForSleeper(sleeper);
    const withTeam = team ? new Map(positions.flatMap(position => (nameTeamIndex.get(`${name}|${team}|${position}`) || []).map(row => [row.espn_id || row.gsis_id || row.name, row] as const))) : new Map<string, CrosswalkRow>();
    const teamCandidates = [...withTeam.values()].filter(row => !row.espn_id || !usedEspnIds.has(row.espn_id));
    if (teamCandidates.length === 1) { addMatch(sleeperId, teamCandidates[0], 'name_team_position', 'high', sleeper, true); continue; }

    const withoutTeam = new Map(positions.flatMap(position => (namePositionIndex.get(`${name}|${position}`) || []).map(row => [row.espn_id || row.gsis_id || row.name, row] as const)));
    const posCandidates = [...withoutTeam.values()].filter(row => !row.espn_id || !usedEspnIds.has(row.espn_id));
    if (posCandidates.length === 1) { addMatch(sleeperId, posCandidates[0], 'name_position', 'medium', sleeper, true); continue; }

    if (teamCandidates.length > 1 || posCandidates.length > 1) {
      result.diagnostics.push({ sleeperPlayerId: sleeperId, name: sleeper.full_name || sleeperId, team, position: normalizePosition(sleeper.position), status: 'ambiguous', method: null, confidence: 'ambiguous', candidates: (teamCandidates.length ? teamCandidates : posCandidates).map(row => row.espn_id || row.gsis_id || row.name) });
    } else {
      result.diagnostics.push({ sleeperPlayerId: sleeperId, name: sleeper.full_name || sleeperId, team, position: normalizePosition(sleeper.position), status: 'unmapped', method: null, confidence: 'unmapped' });
      result.bySleeperId.set(sleeperId, { espnId: null, gsisId: sleeper.gsis_id || null, method: null as unknown as string, confidence: 'unmapped' });
    }
  }
  return result;
}
