import { describe, expect, it } from 'vitest';
import { fixturePlayer } from '../fixtures/leagues.js';
import type { LineupEntry, PlayerEvaluation, ScoringComponent } from '../../shared/types.js';
import { optimizeLineup } from './optimizer.js';
import { buildCorrelationNotes, buildTiebreaks, correlationBonusMap } from './correlation.js';

const component = (sleeperKey: string, projectedPoints: number): ScoringComponent => ({ providerStat: `espn:${sleeperKey}`, projectedStat: null, sleeperKey, multiplier: null, projectedPoints, modeled: true });
const qb = (id: string, team: string, points = 20, opts: Partial<PlayerEvaluation> = {}) => fixturePlayer(id, 'QB', points, { team, scoringComponents: [component('pass_yd', points * 0.6), component('pass_td', points * 0.35)], ...opts });
const catcher = (id: string, position: string, team: string, points = 14, opts: Partial<PlayerEvaluation> = {}) => fixturePlayer(id, position, points, { team, scoringComponents: [component('rec', points * 0.3), component('rec_yd', points * 0.5), component('rec_td', points * 0.2)], ...opts });
const dst = (id: string, team: string, opponent: string, points = 8) => fixturePlayer(id, 'DEF', points, { team, opponent, scoringComponents: [component('sack', 3)] });
const line = (slot: string, player: PlayerEvaluation): LineupEntry => ({ slot, player, changed: false, previousPlayerId: null });
const kinds = (mine: LineupEntry[], theirs: LineupEntry[]) => buildCorrelationNotes(mine, theirs).map(note => note.kind);

describe('correlation bonus map', () => {
  it('nudges a stacked player toward the opponent when I am the favorite, and away when I am the underdog', () => {
    const roster = [catcher('me_wr', 'WR', 'KC')];
    const opponent = [qb('their_qb', 'KC')];
    expect(correlationBonusMap(roster, opponent, 1, 'FAVORITE').get('me_wr')).toBeGreaterThan(0);
    expect(correlationBonusMap(roster, opponent, 1, 'UNDERDOG').get('me_wr')).toBeLessThan(0);
    expect(Math.abs(correlationBonusMap(roster, opponent, 1, 'FAVORITE').get('me_wr')!)).toBeLessThan(1);
  });

  it('grants nothing without a margin, without a link, or for low-volume players', () => {
    const roster = [catcher('me_wr', 'WR', 'KC')];
    expect(correlationBonusMap(roster, [qb('their_qb', 'KC')], 1, null).size).toBe(0);
    expect(correlationBonusMap(roster, [catcher('their_rb', 'RB', 'DAL')], 1, 'FAVORITE').size).toBe(0);
    expect(correlationBonusMap([catcher('bench_wr', 'WR', 'KC', 3)], [qb('their_qb', 'KC')], 1, 'FAVORITE').size).toBe(0);
  });
});

describe('correlation as a lineup tiebreaker', () => {
  const close = [catcher('wr_high', 'WR', 'BUF', 17.9), catcher('wr_stacked', 'WR', 'KC', 17.7)];
  const opponent = [qb('their_qb', 'KC')];

  it('favorite: flips a genuinely close decision toward the player stacked with the opponent and reports the tiebreak', () => {
    const bonus = correlationBonusMap(close, opponent, 1, 'FAVORITE');
    const baseline = optimizeLineup(close, ['WR'], []);
    const lineup = optimizeLineup(close, ['WR'], [], bonus);
    expect(baseline[0].player?.playerId).toBe('wr_high');
    expect(lineup[0].player?.playerId).toBe('wr_stacked');
    const tiebreaks = buildTiebreaks(lineup, baseline, bonus, opponent, 'FAVORITE', 6, 1);
    expect(tiebreaks).toHaveLength(1);
    expect(tiebreaks[0]).toMatchObject({ chosenId: 'wr_stacked', alternativeId: 'wr_high', posture: 'FAVORITE' });
    expect(tiebreaks[0].projectionGiven).toBeCloseTo(0.2, 5);
    expect(tiebreaks[0].explanation).toContain('decision band');
  });

  it('underdog: prefers the option that is not tied to the opponent when the choice is close', () => {
    const stackedHigher = [catcher('wr_stacked', 'WR', 'KC', 17.9), catcher('wr_free', 'WR', 'BUF', 17.7)];
    const bonus = correlationBonusMap(stackedHigher, opponent, 1, 'UNDERDOG');
    const baseline = optimizeLineup(stackedHigher, ['WR'], []);
    const lineup = optimizeLineup(stackedHigher, ['WR'], [], bonus);
    expect(baseline[0].player?.playerId).toBe('wr_stacked');
    expect(lineup[0].player?.playerId).toBe('wr_free');
    expect(buildTiebreaks(lineup, baseline, bonus, opponent, 'UNDERDOG', -6, 1)[0].explanation).toContain('behind');
  });

  it('never overrides a large, clear projection advantage', () => {
    const players = [catcher('wr_high', 'WR', 'BUF', 19), catcher('wr_stacked', 'WR', 'KC', 13)];
    const bonus = correlationBonusMap(players, opponent, 1, 'FAVORITE');
    const baseline = optimizeLineup(players, ['WR'], []);
    const lineup = optimizeLineup(players, ['WR'], [], bonus);
    expect(lineup[0].player?.playerId).toBe('wr_high');
    expect(buildTiebreaks(lineup, baseline, bonus, opponent, 'FAVORITE', 6, 1)).toEqual([]);
  });
});

describe('correlation notes', () => {
  it('finds my pass catcher against the opponent QB and words it without claiming points cancel out', () => {
    const notes = buildCorrelationNotes([line('WR', catcher('my_wr', 'WR', 'KC'))], [line('QB', qb('their_qb', 'KC'))]);
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe('CATCHER_VS_OPPONENT_QB');
    expect(notes[0].explanation).toContain('reducing the relative advantage');
    expect(JSON.stringify(notes)).not.toMatch(/cancel/i);
    expect(notes[0].effect).toBe('INFORMATIONAL');
    expect(notes[0].effectNote).toContain('Informational only');
  });

  it('finds my QB against an opponent pass catcher, and both stacks', () => {
    expect(kinds([line('QB', qb('my_qb', 'KC'))], [line('WR', catcher('their_wr', 'WR', 'KC'))])).toEqual(['QB_VS_OPPONENT_CATCHER']);
    expect(kinds([line('QB', qb('my_qb', 'KC')), line('WR', catcher('my_wr', 'WR', 'KC'))], [line('WR', catcher('their_wr', 'WR', 'DAL'))])).toEqual(['MY_STACK']);
    expect(kinds([line('WR', catcher('my_wr', 'WR', 'DAL'))], [line('QB', qb('their_qb', 'KC')), line('TE', catcher('their_te', 'TE', 'KC'))])).toEqual(['OPPONENT_STACK']);
  });

  it('flags several pass catchers sharing one offense when no QB is in that lineup', () => {
    expect(kinds([line('WR', catcher('a', 'WR', 'KC')), line('TE', catcher('b', 'TE', 'KC'))], [])).toEqual(['MY_SHARED_QB']);
  });

  it('relates a defense to the opposing offense it faces, in both directions', () => {
    const mineFacing = buildCorrelationNotes([line('DEF', dst('my_dst', 'MIN', 'MIA'))], [line('QB', qb('their_qb', 'MIA'))]);
    expect(mineFacing.map(note => note.kind)).toEqual(['MY_DEFENSE_VS_OPPONENT_OFFENSE']);
    expect(mineFacing[0].explanation).toContain('without changing expected points');
    expect(kinds([line('RB', catcher('my_rb', 'RB', 'BUF'))], [line('DEF', dst('their_dst', 'NE', 'BUF'))])).toEqual(['OPPONENT_DEFENSE_VS_MY_OFFENSE']);
  });

  it('avoids false positives: unrelated teams, low-volume players, RBs without receiving volume, and a defense facing a different team', () => {
    expect(kinds([line('WR', catcher('my_wr', 'WR', 'KC'))], [line('QB', qb('their_qb', 'DAL'))])).toEqual([]);
    expect(kinds([line('WR', catcher('my_wr', 'WR', 'KC', 3))], [line('QB', qb('their_qb', 'KC'))])).toEqual([]);
    const rb = fixturePlayer('my_rb', 'RB', 15, { team: 'KC', scoringComponents: [component('rush_yd', 10), component('rec', 1)] });
    expect(kinds([line('RB', rb)], [line('QB', qb('their_qb', 'KC'))])).toEqual([]);
    expect(kinds([line('DEF', dst('my_dst', 'MIN', 'MIA'))], [line('QB', qb('their_qb', 'DAL'))])).toEqual([]);
    expect(kinds([line('DEF', dst('my_dst', 'MIN', 'MIA'))], [line('WR', catcher('their_wr', 'WR', 'MIA', 3))])).toEqual([]);
  });

  it('marks a note DECISION-CHANGING only when the tiebreak actually chose one of its players', () => {
    const tiebreak = { slot: 'WR', chosenId: 'my_wr', chosenName: 'my_wr', alternativeId: 'other', alternativeName: 'other', chosenProjection: 17.7, alternativeProjection: 17.9, projectionGiven: 0.2, band: 1, posture: 'FAVORITE' as const, projectedMargin: 5, correlatedWith: 'their_qb (KC)', explanation: 'x' };
    const notes = buildCorrelationNotes([line('WR', catcher('my_wr', 'WR', 'KC', 17.7))], [line('QB', qb('their_qb', 'KC'))], [tiebreak]);
    expect(notes[0]).toMatchObject({ effect: 'DECISION_CHANGING', appliedAsTiebreak: true });
    expect(notes[0].effectNote).toContain('0.20 projected points given up');
  });
});
