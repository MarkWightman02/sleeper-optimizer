import type { MappingAudit, MappingDiagnostic, MappingMethodGroup, SleeperPlayer } from '../../shared/types.js';
import type { IdentityMatch } from '../services/player-mapping.js';
import { normalizeTeam } from '../services/player-mapping.js';

const EMPTY: Record<MappingMethodGroup, number> = {
  crosswalk_sleeper_id: 0, espn_id: 0, gsis_id: 0, name_team_position: 0, name_position: 0, persisted: 0, team_code: 0, ambiguous: 0, unmapped: 0
};

export function methodGroup(match: IdentityMatch | undefined, diagnostic: MappingDiagnostic | undefined): MappingMethodGroup {
  if (diagnostic?.status === 'ambiguous') return 'ambiguous';
  if (!match || match.confidence === 'unmapped' || !match.method) return 'unmapped';
  if (match.method.startsWith('persisted')) return 'persisted';
  if (match.method === 'crosswalk:sleeper_id') return 'crosswalk_sleeper_id';
  if (match.method === 'team_code') return 'team_code';
  if (match.method === 'gsis_id' || match.method === 'espn_id' || match.method === 'name_team_position' || match.method === 'name_position') return match.method;
  return 'unmapped';
}

/** Counts how each in-scope player's identity was resolved and lists everything that rests on a name match or failed outright. */
export function buildMappingAudit(scope: string, ids: Iterable<string>, bySleeperId: Map<string, IdentityMatch>, diagnostics: MappingDiagnostic[], players: Record<string, SleeperPlayer>, needsProjection: (id: string) => boolean, espnProjectedButUnmapped: MappingAudit['espnProjectedButUnmapped'] = []): MappingAudit {
  const diagnosticById = new Map(diagnostics.flatMap(item => item.sleeperPlayerId ? [[item.sleeperPlayerId, item] as const] : []));
  const byMethod = { ...EMPTY };
  const needsReview: MappingAudit['needsReview'] = [];
  let total = 0;
  for (const id of new Set(ids)) {
    const player = players[id];
    if (!player) continue;
    total++;
    const match = bySleeperId.get(id);
    const group = methodGroup(match, diagnosticById.get(id));
    byMethod[group]++;
    if (['name_team_position', 'name_position', 'ambiguous', 'unmapped'].includes(group) && (group === 'name_team_position' || group === 'name_position' || needsProjection(id))) {
      needsReview.push({ name: player.full_name || `${player.first_name || ''} ${player.last_name || ''}`.trim() || id, team: normalizeTeam(player.team), position: player.position || null, method: match?.method || null, confidence: match?.confidence || diagnosticById.get(id)?.confidence || 'unmapped', sleeperPlayerId: id });
    }
  }
  return { scope, total, byMethod, fallbackCount: byMethod.name_team_position + byMethod.name_position, espnProjectedButUnmapped: espnProjectedButUnmapped.slice(0, 60), needsReview: needsReview.slice(0, 60) };
}
