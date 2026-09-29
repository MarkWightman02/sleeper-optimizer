import { afterEach, describe, expect, it } from 'vitest';
import type { SleeperPlayer } from '../../shared/types.js';
import type { CrosswalkIndex, CrosswalkRow } from './crosswalk.js';
import { deletePlayerMapping } from '../db.js';
import { normalizePlayerName, normalizePosition, normalizeTeam, resolvePlayerIdentities } from './player-mapping.js';

const created: string[] = [];
afterEach(() => { for (const id of created.splice(0)) deletePlayerMapping('espn', id); });

function row(overrides: Partial<CrosswalkRow>): CrosswalkRow {
  return { sleeper_id: null, gsis_id: null, espn_id: null, yahoo_id: null, pff_id: null, rotowire_id: null, name: '', merge_name: '', position: null, team: null, ...overrides };
}

function indexOf(rows: CrosswalkRow[]): CrosswalkIndex {
  const bySleeperId = new Map<string, CrosswalkRow>();
  const byGsisId = new Map<string, CrosswalkRow>();
  const byEspnId = new Map<string, CrosswalkRow>();
  for (const r of rows) {
    if (r.sleeper_id) bySleeperId.set(r.sleeper_id, r);
    if (r.gsis_id) byGsisId.set(r.gsis_id, r);
    if (r.espn_id) byEspnId.set(r.espn_id, r);
  }
  return { bySleeperId, byGsisId, byEspnId, retrievedAt: '2026-09-28T00:00:00Z', rowCount: rows.length };
}

describe('player identity mapping', () => {
  it('normalizes suffixes, team aliases, and defenses', () => {
    expect(normalizePlayerName("D'Andre Swift Jr.")).toBe('dandreswift');
    expect(normalizeTeam('JAX')).toBe('JAC');
    expect(normalizePosition('D/ST')).toBe('DEF');
  });

  it('prefers the crosswalk\'s own sleeper_id join over anything else', () => {
    const sleepers: Record<string, SleeperPlayer> = { map_exact_test: { player_id: 'map_exact_test', full_name: 'Different Name', position: 'QB', team: 'BUF', active: true } };
    created.push('map_exact_test');
    const crosswalk = indexOf([row({ sleeper_id: 'map_exact_test', espn_id: '4242', name: 'Josh Real Name', position: 'QB', team: 'BUF' })]);
    const result = resolvePlayerIdentities(sleepers, crosswalk);
    expect(result.bySleeperId.get('map_exact_test')?.espnId).toBe('4242');
    expect(result.bySleeperId.get('map_exact_test')?.confidence).toBe('exact');
  });

  it('falls back to a gsis_id cross-match when the crosswalk lacks the sleeper_id', () => {
    const sleepers: Record<string, SleeperPlayer> = { map_gsis_test: { player_id: 'map_gsis_test', full_name: 'Someone', position: 'RB', team: 'SEA', active: true, gsis_id: '00-0099999' } };
    created.push('map_gsis_test');
    const crosswalk = indexOf([row({ gsis_id: '00-0099999', espn_id: '5555', name: 'Someone Else', position: 'RB', team: 'SEA' })]);
    const result = resolvePlayerIdentities(sleepers, crosswalk);
    expect(result.bySleeperId.get('map_gsis_test')?.espnId).toBe('5555');
    expect(result.bySleeperId.get('map_gsis_test')?.confidence).toBe('high');
  });

  it('falls back to normalized name+team+position when no ID join exists', () => {
    const sleepers: Record<string, SleeperPlayer> = { map_name_test: { player_id: 'map_name_test', full_name: 'Alex Smith', position: 'QB', team: 'AAA', active: true } };
    created.push('map_name_test');
    const crosswalk = indexOf([row({ espn_id: '111', name: 'Alex Smith', position: 'QB', team: 'AAA' })]);
    const result = resolvePlayerIdentities(sleepers, crosswalk);
    expect(result.bySleeperId.get('map_name_test')?.espnId).toBe('111');
    expect(result.bySleeperId.get('map_name_test')?.confidence).toBe('high');
  });

  it('rejects ambiguous same-name candidates instead of guessing', () => {
    const sleepers: Record<string, SleeperPlayer> = { map_amb_test: { player_id: 'map_amb_test', full_name: 'Alex Smith', position: 'QB', team: 'AAA', active: true } };
    const crosswalk = indexOf([
      row({ espn_id: '111', name: 'Alex Smith', position: 'QB', team: 'AAA' }),
      row({ espn_id: '222', name: 'Alex Smith', position: 'QB', team: 'AAA' })
    ]);
    const result = resolvePlayerIdentities(sleepers, crosswalk);
    expect(result.bySleeperId.has('map_amb_test')).toBe(false);
    expect(result.diagnostics.find(item => item.sleeperPlayerId === 'map_amb_test')?.status).toBe('ambiguous');
  });

  it('reports players absent from the crosswalk as unmapped rather than guessing', () => {
    const sleepers: Record<string, SleeperPlayer> = { map_unknown_test: { player_id: 'map_unknown_test', full_name: 'Brand New Rookie', position: 'WR', team: 'DAL', active: true } };
    const result = resolvePlayerIdentities(sleepers, indexOf([]));
    expect(result.bySleeperId.get('map_unknown_test')?.confidence).toBe('unmapped');
    expect(result.diagnostics.find(item => item.sleeperPlayerId === 'map_unknown_test')?.status).toBe('unmapped');
  });
});
