import { describe, expect, it } from 'vitest';
import { calculateAvailableIds, ownedIds } from './analysis.js';
import { applyReplacementValues, calculateReplacementLevels, eligibleForSlot, lineupTotal, optimizeLineup, searchTransactions } from './optimizer.js';
import { fixturePlayer, flexFixture, ownershipFixture, superFlexFixture } from '../fixtures/leagues.js';

describe('ownership and availability', () => {
  it('counts active, reserve, and taxi players as owned', () => {
    expect([...ownedIds(ownershipFixture.rosters)].sort()).toEqual(['owned', 'reserve', 'taxi']);
  });

  it('never returns another roster’s players as free agents', () => {
    expect(calculateAvailableIds(ownershipFixture.players, ownershipFixture.rosters, ['QB', 'RB', 'WR', 'TE'])).toEqual(['available']);
  });
});

describe('positional eligibility', () => {
  it('handles flex and super flex rules', () => {
    expect(eligibleForSlot(['RB'], 'FLEX')).toBe(true);
    expect(eligibleForSlot(['QB'], 'FLEX')).toBe(false);
    expect(eligibleForSlot(['QB'], 'SUPER_FLEX')).toBe(true);
    expect(eligibleForSlot(['CB'], 'IDP_FLEX')).toBe(true);
  });

  it('normalizes DST and DEF', () => expect(eligibleForSlot(['DST'], 'DEF')).toBe(true));
});

describe('exact lineup optimization', () => {
  it('solves a flex assignment that greedy flex-first selection misses', () => {
    const lineup = optimizeLineup(flexFixture.players, flexFixture.rosterPositions);
    expect(lineupTotal(lineup)).toBe(19);
    expect(lineup.find(entry => entry.slot === 'WR')?.player?.playerId).toBe('WR_A');
    expect(lineup.find(entry => entry.slot === 'FLEX')?.player?.playerId).toBe('RB_A');
  });

  it('uses a second quarterback in super flex', () => {
    const lineup = optimizeLineup(superFlexFixture.players, superFlexFixture.rosterPositions);
    expect(lineup.find(entry => entry.slot === 'SUPER_FLEX')?.player?.playerId).toBe('QB_B');
    expect(lineupTotal(lineup)).toBe(50);
  });

  it('supports repeated overlapping flex slots without duplicating players', () => {
    const players = [fixturePlayer('r1', 'RB', 10), fixturePlayer('w1', 'WR', 9), fixturePlayer('t1', 'TE', 8), fixturePlayer('w2', 'WR', 7)];
    const lineup = optimizeLineup(players, ['FLEX', 'FLEX', 'REC_FLEX']);
    const ids = lineup.map(entry => entry.player?.playerId);
    expect(new Set(ids).size).toBe(3);
    expect(lineupTotal(lineup)).toBe(27);
  });

  it('does not create an illegal lineup when no player fits a slot', () => {
    const lineup = optimizeLineup([fixturePlayer('qb', 'QB', 30)], ['RB']);
    expect(lineup[0].player).toBeNull();
  });

  it('preserves the current starter when bye-week projections are missing', () => {
    const players = [fixturePlayer('current', 'RB', null), fixturePlayer('bench', 'RB', null)];
    const lineup = optimizeLineup(players, ['RB'], ['current']);
    expect(lineup[0].player?.playerId).toBe('current');
  });

  it('does not invent availability-only lineup changes when all projections are missing', () => {
    const players = [fixturePlayer('current-out', 'RB', null, { eligible: false, injuryStatus: 'Out' }), fixturePlayer('bench', 'RB', null)];
    const lineup = optimizeLineup(players, ['RB', 'BN'], ['current-out']);
    expect(lineup[0].player?.playerId).toBe('current-out');
    expect(lineup[0].changed).toBe(false);
  });

  it('excludes out or ineligible players even with a high projection', () => {
    const players = [fixturePlayer('out', 'RB', 30, { eligible: false, injuryStatus: 'Out' }), fixturePlayer('healthy', 'RB', 10)];
    expect(optimizeLineup(players, ['RB'])[0].player?.playerId).toBe('healthy');
  });
});

describe('transaction search', () => {
  it('finds a beneficial add/drop and re-optimizes the lineup', () => {
    const roster = [fixturePlayer('starter', 'RB', 8, { rosterStatus: 'starter' }), fixturePlayer('drop', 'RB', 2)];
    const free = [fixturePlayer('add', 'RB', 24, { rosterStatus: 'free_agent', acquisition: { kind: 'FREE_AGENT', reason: 'test' } })];
    const result = searchTransactions(roster, free, ['RB', 'BN'], ['starter']);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].add.playerId).toBe('add');
    expect(result.transactions[0].drop.playerId).toBe('drop');
  });

  it('does not recommend marginal churn', () => {
    const roster = [fixturePlayer('starter', 'RB', 10, { rosterStatus: 'starter' }), fixturePlayer('bench', 'RB', 9)];
    const free = [fixturePlayer('tiny', 'RB', 10.5, { rosterStatus: 'free_agent' })];
    expect(searchTransactions(roster, free, ['RB', 'BN'], ['starter']).transactions).toHaveLength(0);
  });

  it('derives positional replacement level from league starter demand', () => {
    const free = [fixturePlayer('rb1', 'RB', 12), fixturePlayer('rb2', 'RB', 10), fixturePlayer('rb3', 'RB', 8), fixturePlayer('wr1', 'WR', 9)];
    const levels = calculateReplacementLevels(free, ['RB', 'FLEX', 'BN']);
    expect(levels.RB.starterDemandPerTeam).toBe(2);
    expect(levels.RB.replacementLevel).toBe(11);
    applyReplacementValues(free, levels);
    expect(free[0].valueOverReplacement).toBe(1);
  });

  it('does not drop a valuable bye-week player for a short-term gain', () => {
    const roster = [
      fixturePlayer('starter', 'RB', 10, { rosterStatus: 'starter', restOfSeasonValue: 100 }),
      fixturePlayer('valuable-bye', 'RB', null, { restOfSeasonValue: 220 }),
      fixturePlayer('replacement-bench', 'RB', 2, { restOfSeasonValue: 20 })
    ];
    const free = [fixturePlayer('add', 'RB', 12, { rosterStatus: 'free_agent', restOfSeasonValue: 40 })];
    const result = searchTransactions(roster, free, ['RB', 'BN', 'BN'], ['starter'], { week: 4 });
    expect(result.transactions.every(tx => tx.drop.playerId !== 'valuable-bye')).toBe(true);
  });

  it('can select a supported two-player add/drop set', () => {
    const roster = [
      fixturePlayer('rb-start', 'RB', 8, { rosterStatus: 'starter', restOfSeasonValue: 80 }),
      fixturePlayer('wr-start', 'WR', 7, { rosterStatus: 'starter', restOfSeasonValue: 70 }),
      fixturePlayer('rb-drop', 'RB', 1, { restOfSeasonValue: 10 }),
      fixturePlayer('wr-drop', 'WR', 1, { restOfSeasonValue: 10 })
    ];
    const acquisition = { kind: 'FREE_AGENT' as const, reason: 'test' };
    const free = [
      fixturePlayer('rb-add', 'RB', 26, { rosterStatus: 'free_agent', restOfSeasonValue: 260, acquisition }),
      fixturePlayer('wr-add', 'WR', 25, { rosterStatus: 'free_agent', restOfSeasonValue: 250, acquisition })
    ];
    const result = searchTransactions(roster, free, ['RB', 'WR', 'BN', 'BN'], ['rb-start', 'wr-start'], { week: 4 });
    expect(result.transactions).toHaveLength(2);
    expect(new Set(result.transactions.map(tx => tx.add.playerId))).toEqual(new Set(['rb-add', 'wr-add']));
  });
});
