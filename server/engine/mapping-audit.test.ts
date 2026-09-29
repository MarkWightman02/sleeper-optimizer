import { describe, expect, it } from 'vitest';
import type { MappingDiagnostic, SleeperPlayer } from '../../shared/types.js';
import { buildMappingAudit, methodGroup } from './mapping-audit.js';

const players: Record<string, SleeperPlayer> = {
  a: { player_id: 'a', full_name: 'Exact Guy', team: 'NYJ', position: 'RB' },
  b: { player_id: 'b', full_name: 'Fuzzy Guy', team: 'JAX', position: 'WR' },
  c: { player_id: 'c', full_name: 'Twin', team: 'DAL', position: 'TE' },
  d: { player_id: 'd', full_name: 'Nobody', team: 'CHI', position: 'QB' },
  DAL: { player_id: 'DAL', full_name: 'Dallas Cowboys', team: 'DAL', position: 'DEF' }
};

describe('mapping audit', () => {
  it('counts each identity method and lists fuzzy, ambiguous and unmapped players for review', () => {
    const bySleeperId = new Map([
      ['a', { espnId: '1', gsisId: 'g1', method: 'crosswalk:sleeper_id', confidence: 'exact' as const }],
      ['b', { espnId: '2', gsisId: null, method: 'name_team_position', confidence: 'high' as const }],
      ['d', { espnId: null, gsisId: null, method: null as unknown as string, confidence: 'unmapped' as const }],
      ['DAL', { espnId: null, gsisId: null, method: 'team_code', confidence: 'exact' as const }]
    ]);
    const diagnostics: MappingDiagnostic[] = [{ sleeperPlayerId: 'c', name: 'Twin', team: 'DAL', position: 'TE', status: 'ambiguous', method: null, confidence: 'ambiguous' }];
    const audit = buildMappingAudit('test', ['a', 'b', 'c', 'd', 'DAL'], bySleeperId, diagnostics, players, () => true);
    expect(audit.total).toBe(5);
    expect(audit.byMethod).toMatchObject({ crosswalk_sleeper_id: 1, name_team_position: 1, ambiguous: 1, unmapped: 1, team_code: 1 });
    expect(audit.fallbackCount).toBe(1);
    expect(audit.needsReview.map(item => item.name).sort()).toEqual(['Fuzzy Guy', 'Nobody', 'Twin']);
  });

  it('groups persisted and unknown matches', () => {
    expect(methodGroup({ espnId: '1', gsisId: null, method: 'persisted:name_position', confidence: 'medium' }, undefined)).toBe('persisted');
    expect(methodGroup(undefined, undefined)).toBe('unmapped');
  });
});
