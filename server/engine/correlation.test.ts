import { describe, expect, it } from 'vitest';
import { fixturePlayer } from '../fixtures/leagues.js';
import { optimizeLineup } from './optimizer.js';
import { buildCorrelationNotes, correlationBonusMap } from './correlation.js';

describe('correlation bonus map', () => {
  it('grants a bonus, capped well below the decision band, to a player stacked with an opponent starter', () => {
    const myRoster = [fixturePlayer('me_wr', 'WR', 17.7, { team: 'KC' })];
    const opponentStarters = [fixturePlayer('their_qb', 'QB', 20, { team: 'KC' })];
    const bonus = correlationBonusMap(myRoster, opponentStarters, 1);
    expect(bonus.get('me_wr')).toBeGreaterThan(0);
    expect(bonus.get('me_wr')!).toBeLessThan(1);
  });

  it('grants no bonus when no team/position stack exists', () => {
    const myRoster = [fixturePlayer('me_wr', 'WR', 17.7, { team: 'KC' })];
    const opponentStarters = [fixturePlayer('their_rb', 'RB', 20, { team: 'DAL' })];
    expect(correlationBonusMap(myRoster, opponentStarters, 1).size).toBe(0);
  });
});

describe('correlation as a lineup tiebreaker', () => {
  it('flips a genuinely close decision toward the player stacked with the opponent', () => {
    const players = [fixturePlayer('wr_high', 'WR', 17.9, { team: 'BUF' }), fixturePlayer('wr_stacked', 'WR', 17.7, { team: 'KC' })];
    const opponentStarters = [fixturePlayer('their_qb', 'QB', 20, { team: 'KC' })];
    const bonus = correlationBonusMap(players, opponentStarters, 1);
    const lineup = optimizeLineup(players, ['WR'], [], bonus);
    expect(lineup[0].player?.playerId).toBe('wr_stacked');
  });

  it('never overrides a large, clear projection advantage', () => {
    const players = [fixturePlayer('wr_high', 'WR', 19, { team: 'BUF' }), fixturePlayer('wr_stacked', 'WR', 13, { team: 'KC' })];
    const opponentStarters = [fixturePlayer('their_qb', 'QB', 20, { team: 'KC' })];
    const bonus = correlationBonusMap(players, opponentStarters, 1);
    const lineup = optimizeLineup(players, ['WR'], [], bonus);
    expect(lineup[0].player?.playerId).toBe('wr_high');
  });
});

describe('correlation notes', () => {
  it('explains a QB/pass-catcher stack between the two final lineups', () => {
    const mine = [{ slot: 'WR', player: fixturePlayer('my_wr', 'WR', 15, { team: 'KC' }), changed: false, previousPlayerId: null }];
    const theirs = [{ slot: 'QB', player: fixturePlayer('their_qb', 'QB', 22, { team: 'KC' }), changed: false, previousPlayerId: null }];
    const notes = buildCorrelationNotes(mine, theirs, new Set(['my_wr']));
    expect(notes).toHaveLength(1);
    expect(notes[0].appliedAsTiebreak).toBe(true);
    expect(notes[0].explanation).toContain('tiebreaker');
  });

  it('produces no notes across unrelated teams', () => {
    const mine = [{ slot: 'WR', player: fixturePlayer('my_wr', 'WR', 15, { team: 'KC' }), changed: false, previousPlayerId: null }];
    const theirs = [{ slot: 'QB', player: fixturePlayer('their_qb', 'QB', 22, { team: 'DAL' }), changed: false, previousPlayerId: null }];
    expect(buildCorrelationNotes(mine, theirs, new Set())).toHaveLength(0);
  });
});
