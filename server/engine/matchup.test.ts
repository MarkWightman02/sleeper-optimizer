import { describe, expect, it } from 'vitest';
import { availabilityPlayer } from '../fixtures/leagues.js';
import type { LineupEntry, PlayerEvaluation } from '../../shared/types.js';
import { compareUncertainty, largestEdges, lineupTotals, positionEdges, uncertainStarters, uncertaintyProfile, waiverMatchupNotes } from './matchup.js';
import { fixturePlayer } from '../fixtures/leagues.js';

const line = (slot: string, player: PlayerEvaluation | null): LineupEntry => ({ slot, player, changed: false, previousPlayerId: null });

describe('matchup totals', () => {
  it('sums availability-weighted expected points and separate published points', () => {
    const totals = lineupTotals([line('RB', availabilityPlayer('a', 'RB', 15)), line('WR', availabilityPlayer('b', 'WR', 10, { status: 'Questionable' }))]);
    expect(totals.published).toBe(25);
    expect(totals.expected).toBe(23.5);
    expect(totals.missing).toEqual([]);
  });

  it('counts a player ruled out as a known 0, but never treats a missing projection as 0', () => {
    const out = availabilityPlayer('out', 'RB', 16, { status: 'Out' });
    expect(lineupTotals([line('RB', out), line('WR', availabilityPlayer('b', 'WR', 10))]).expected).toBe(10);
    const noProjection = fixturePlayer('none', 'WR', null);
    const totals = lineupTotals([line('RB', availabilityPlayer('a', 'RB', 15)), line('WR', noProjection), line('TE', null)]);
    expect(totals.expected).toBeNull();
    expect(totals.published).toBeNull();
    expect(totals.missing).toEqual(['none (WR)', 'TE (empty)']);
  });
});

describe('positional edges and uncertainty', () => {
  const mine = [line('QB', availabilityPlayer('q1', 'QB', 22)), line('RB', availabilityPlayer('r1', 'RB', 12)), line('RB', availabilityPlayer('r2', 'RB', 10)), line('WR', availabilityPlayer('w1', 'WR', 9))];
  const theirs = [line('QB', availabilityPlayer('q2', 'QB', 18)), line('RB', availabilityPlayer('r3', 'RB', 15)), line('RB', availabilityPlayer('r4', 'RB', 14)), line('WR', availabilityPlayer('w2', 'WR', 9.2))];

  it('groups by slot, reports signed differences, and picks the largest advantage and disadvantage', () => {
    const edges = positionEdges(mine, theirs);
    expect(edges.find(edge => edge.group === 'QB')?.difference).toBe(4);
    expect(edges.find(edge => edge.group === 'RB')).toMatchObject({ mine: 22, opponent: 29, difference: -7 });
    expect(largestEdges(edges, 'advantage')[0].group).toBe('QB');
    expect(largestEdges(edges, 'disadvantage')[0].group).toBe('RB');
    expect(largestEdges(edges, 'advantage').map(edge => edge.group)).not.toContain('WR');
  });

  it('lists injury-uncertain starters on both sides with their play chance', () => {
    const list = uncertainStarters([line('RB', availabilityPlayer('r1', 'RB', 12, { status: 'Questionable' }))], [line('WR', availabilityPlayer('w2', 'WR', 9, { status: 'Doubtful' })), line('QB', availabilityPlayer('q', 'QB', 20))]);
    expect(list.map(item => [item.side, item.name, item.status, item.playProbability])).toEqual([['mine', 'r1', 'QUESTIONABLE', 0.85], ['opponent', 'w2', 'DOUBTFUL', 0.25]]);
  });

  it('says which side is more uncertain only when the measures agree, and never invents a win probability', () => {
    const steady = uncertaintyProfile(mine);
    const risky = uncertaintyProfile([line('RB', availabilityPlayer('r', 'RB', 16, { status: 'Doubtful' })), line('WR', availabilityPlayer('w', 'WR', 12, { status: 'Questionable' }))]);
    expect(compareUncertainty(steady, risky).moreUncertain).toBe('opponent');
    expect(compareUncertainty(steady, steady).moreUncertain).toBe('even');
    expect(compareUncertainty({ availabilityExposure: 5, lowerConfidenceStarters: 0, unprojectedStarters: 0 }, { availabilityExposure: 0, lowerConfidenceStarters: 3, unprojectedStarters: 0 }).moreUncertain).toBe('unclear');
    expect(compareUncertainty(steady, risky).explanation).toContain('not a win probability');
  });
});

describe('waiver matchup context', () => {
  it('only attaches supporting notes for adds that relate to the opponent lineup', () => {
    const passing = { providerStat: 'espn:3', projectedStat: null, sleeperKey: 'pass_yd', multiplier: null, projectedPoints: 12, modeled: true };
    const receiving = { providerStat: 'espn:53', projectedStat: null, sleeperKey: 'rec_yd', multiplier: null, projectedPoints: 9, modeled: true };
    const opponentQb = fixturePlayer('their_qb', 'QB', 20, { team: 'KC', scoringComponents: [passing] });
    const linked = { add: fixturePlayer('add_wr', 'WR', 12, { team: 'KC', scoringComponents: [receiving] }), drop: fixturePlayer('drop', 'WR', 5), weeklyGain: 1, restOfSeasonGain: null, confidence: 'High' as const, reasons: [] };
    const unrelated = { ...linked, add: fixturePlayer('add_other', 'WR', 12, { team: 'DAL', scoringComponents: [receiving] }) };
    const notes = waiverMatchupNotes([linked, unrelated], [opponentQb]);
    expect(notes).toHaveLength(1);
    expect(notes[0].note).toContain('does not change the waiver verdict');
  });
});
