import { describe, expect, it } from 'vitest';
import { scoreEspnProjection } from './scoring.js';

const LEAGUE = {
  blk_kick: 2, def_st_ff: 1, def_st_fum_rec: 1, def_st_td: 6, def_td: 6, ff: 1, fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50_59: 5, fgm_60p: 6,
  fum_lost: -2, fum_rec: 2, int: 2, pass_2pt: 2, pass_int: -2, pass_td: 6, pass_yd: 0.04, pts_allow_0: 10, pts_allow_14_20: 1, pts_allow_1_6: 7,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4, pts_allow_7_13: 4, rec: 1, rec_2pt: 2, rec_td: 6, rec_yd: 0.1, rush_2pt: 2, rush_td: 6,
  rush_yd: 0.1, sack: 1, safe: 2, xpm: 1
};

describe('ESPN stat-line rescoring', () => {
  it('scores quarterback decimals, negatives, rushing, and the 300/400 yard bonus bucket', () => {
    const result = scoreEspnProjection({ 3: 305, 4: 2, 20: 1, 24: 40, 17: 1 }, { pass_yd: .04, pass_td: 4, pass_int: -2, rush_yd: .1, bonus_pass_yd_300: 3 }, 'QB');
    expect(result.points).toBe(25.2);
    expect(result.coverage).toBe(100);
    expect(result.unsupportedKeys).toEqual([]);
  });

  it.each([[0, 14], [.5, 16.5], [1, 19]])('honors %.1f PPR', (ppr, expected) => {
    expect(scoreEspnProjection({ 24: 20, 53: 5, 42: 60, 43: 1 }, { rush_yd: .1, rec: ppr, rec_yd: .1, rec_td: 6 }, 'RB').points).toBe(expected);
  });

  it('scores fumbles LOST (stat 72), not total fumbles (stat 68)', () => {
    const result = scoreEspnProjection({ 24: 50, 68: 0.4, 72: 0.1 }, { rush_yd: .1, fum_lost: -2 }, 'RB');
    expect(result.points).toBeCloseTo(4.8, 5);
    expect(result.statLine['72']).toBe(0.1);
  });

  it('withholds a projection when the line lacks every core statistic (never 0)', () => {
    expect(scoreEspnProjection({ 23: 5 }, { rec_yd: .1 }, 'WR').points).toBeNull();
    expect(scoreEspnProjection({}, { pass_yd: .04 }, 'QB').points).toBeNull();
  });

  it('does not penalize coverage when ESPN omits a secondary statistic (a WR with no rushing volume)', () => {
    const result = scoreEspnProjection({ 53: 5, 42: 60, 43: .5 }, LEAGUE, 'WR');
    expect(result.coverage).toBe(100);
    expect(result.omittedKeys).toEqual(expect.arrayContaining(['rush_yd', 'rush_td']));
    expect(result.points).toBeCloseTo(5 + 6 + 3, 5);
  });

  describe('kickers', () => {
    it('converts ESPN buckets exactly when the league scores 0-39 identically', () => {
      const line = { 83: 2, 80: 1.05, 77: .49, 74: .37, 86: 1.32 };
      const result = scoreEspnProjection(line, LEAGUE, 'K');
      expect(result.points).toBeCloseTo(1.05 * 3 + .49 * 4 + .37 * 5 + 1.32, 5);
      expect(result.coverage).toBe(100);
      expect(result.unsupportedKeys).toEqual([]);
      expect(result.approximations.join(' ')).toContain('50+');
      expect(result.minorUnmodeledKeys).toContain('fgm_60p');
    });

    it('marks 0-39 unsupported when the league splits them with different values', () => {
      const result = scoreEspnProjection({ 83: 2, 80: 1, 86: 1 }, { ...LEAGUE, fgm_0_19: 2, fgm_30_39: 3 }, 'K');
      expect(result.unsupportedKeys).toEqual(expect.arrayContaining(['fgm_0_19', 'fgm_30_39']));
      expect(result.coverage).toBeLessThan(100);
    });
  });

  describe('team defense', () => {
    const line = {
      89: 0.0061, 90: 0.0275, 91: 0.1159, 92: 0.1319, 121: 0.1449, 122: 0.2443, 123: 0.2034, 124: 0.1114, 125: 0.0145,
      99: 2.685, 95: 0.746, 96: 0.404, 97: 0.113, 98: 0.0154, 106: 0.622, 103: 0.0619, 104: 0.0311, 93: 0.0073, 101: 0.0114, 102: 0.0142
    };

    it('uses Sleeper stat keys (sack/int/fum_rec/blk_kick), points-allowed buckets and return TDs', () => {
      const result = scoreEspnProjection(line, LEAGUE, 'DEF');
      const pa = 10 * 0.0061 + 7 * 0.0275 + 4 * 0.1159 + 1 * (0.1319 + 0.1449 * 0.75) + 0 * (0.1449 * 0.25 + 0.2443) + -1 * 0.2034 + -4 * (0.1114 + 0.0145);
      const expected = pa + 2.685 + 2 * 0.746 + 2 * 0.404 + 2 * 0.113 + 2 * 0.0154 + 1 * 0.622 + 6 * (0.0619 + 0.0311 + 0.0073) + 6 * (0.0114 + 0.0142);
      expect(result.points).toBeCloseTo(expected, 2);
      expect(result.coverage).toBe(100);
      expect(result.unsupportedKeys).toEqual([]);
      expect(result.minorUnmodeledKeys).toEqual(expect.arrayContaining(['def_st_ff', 'def_st_fum_rec']));
      expect(result.approximations.join(' ')).toContain('points-allowed');
    });

    it('withholds the defense projection when the points-allowed distribution is incomplete', () => {
      const { 121: _drop, ...partial } = line;
      expect(scoreEspnProjection(partial, LEAGUE, 'DEF').points).toBeNull();
    });
  });

  it('scores IDP tackles and sacks independently of team defense keys', () => {
    const result = scoreEspnProjection({ 108: 6, 107: 2, 99: 1, 109: 8 }, { idp_tkl_solo: 1.5, idp_tkl_ast: .5, idp_sack: 4 }, 'LB');
    expect(result.points).toBe(14);
  });

  it('distinguishes an unsupported scoring key from an omitted statistic', () => {
    const result = scoreEspnProjection({ 3: 250 }, { pass_yd: .04, pass_td: 4, pass_rtg_bonus: 1 }, 'QB');
    expect(result.points).toBe(10);
    expect(result.unsupportedKeys).toEqual(['pass_rtg_bonus']);
    expect(result.omittedKeys).toEqual(['pass_td']);
  });
});
