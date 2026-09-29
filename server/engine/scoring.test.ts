import { describe, expect, it } from 'vitest';
import { scoreEspnProjection } from './scoring.js';

describe('ESPN stat-line rescoring', () => {
  it('scores quarterback decimals, negatives, rushing, and the 300/400 yard bonus bucket', () => {
    const result = scoreEspnProjection(
      { 3: 305, 4: 2, 20: 1, 24: 40, 17: 1 },
      { pass_yd: .04, pass_td: 4, pass_int: -2, rush_yd: .1, bonus_pass_yd_300: 3 },
      'QB'
    );
    expect(result.points).toBe(25.2);
    expect(result.coverage).toBe(100);
    expect(result.unsupportedKeys).toEqual([]);
  });

  it.each([[0, 14], [.5, 16.5], [1, 19]])('honors %.1f PPR', (ppr, expected) => {
    const result = scoreEspnProjection({ 24: 20, 53: 5, 42: 60, 43: 1 }, { rush_yd: .1, rec: ppr, rec_yd: .1, rec_td: 6 }, 'RB');
    expect(result.points).toBe(expected);
  });

  it('scores kicking independently', () => {
    expect(scoreEspnProjection({ 83: 2, 86: 3 }, { fgm: 3, xpm: 1 }, 'K').points).toBe(9);
  });

  it('scores DST sacks/interceptions but marks points-allowed buckets unsupported rather than guessing a boundary', () => {
    const result = scoreEspnProjection({ 99: 3, 95: 1 }, { def_sack: 1, def_int: 2, pts_allow_1_6: 7 }, 'DEF');
    expect(result.points).toBe(5);
    expect(result.unsupportedKeys).toContain('pts_allow_1_6');
  });

  it('scores IDP tackles and sacks independently of team defense keys', () => {
    const result = scoreEspnProjection({ 108: 6, 107: 2, 99: 1 }, { idp_tkl_solo: 1.5, idp_tkl_ast: .5, idp_sack: 4 }, 'LB');
    expect(result.points).toBe(14);
  });

  it('distinguishes a missing weekly stat from a truly unsupported scoring key', () => {
    const result = scoreEspnProjection({ 3: 250 }, { pass_yd: .04, pass_td: 4, pass_rtg_bonus: 1 }, 'QB');
    expect(result.points).toBe(10);
    expect(result.coverage).toBe(33);
    expect(result.unsupportedKeys).toEqual(['pass_rtg_bonus']);
    expect(result.components.find(item => item.sleeperKey === 'pass_td')?.note).toContain('did not include');
  });

  it('never fabricates points when no relevant statistic was projected', () => {
    const result = scoreEspnProjection({}, { pass_yd: .04 }, 'QB');
    expect(result.points).toBeNull();
  });
});
