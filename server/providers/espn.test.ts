import { describe, expect, it } from 'vitest';
import { aggregateEspnRankings, findWeeklyProjection } from './espn.js';

const entry = (rank: number, rankSourceId: number, slotId: number, rankType = 'PPR') => ({ rank, rankSourceId, slotId, rankType });

describe('ESPN weekly projection selection', () => {
  const stats = [
    { scoringPeriodId: 4, seasonId: 2026, statSourceId: 0, stats: { 3: 999 } },
    { scoringPeriodId: 3, seasonId: 2026, statSourceId: 1, stats: { 3: 111 } },
    { scoringPeriodId: 4, seasonId: 2025, statSourceId: 1, stats: { 3: 222 } },
    { scoringPeriodId: 4, seasonId: 2026, statSourceId: 1, statSplitTypeId: 0, stats: { 3: 333 } },
    { scoringPeriodId: 4, seasonId: 2026, statSourceId: 1, statSplitTypeId: 1, stats: { 3: 250 } }
  ];

  it('takes only the projection (source 1) for the exact week and season, never actuals or another week', () => {
    expect(findWeeklyProjection(stats, 2026, 4)?.stats).toEqual({ 3: 250 });
    expect(findWeeklyProjection(stats, 2026, 5)).toBeUndefined();
    expect(findWeeklyProjection(undefined, 2026, 4)).toBeUndefined();
    expect(findWeeklyProjection([{ scoringPeriodId: 4, seasonId: 2026, statSourceId: 0, stats: { 3: 1 } }], 2026, 4)).toBeUndefined();
  });
});

describe('ESPN ranking aggregation', () => {
  it('collapses one rank per expert into a single source-level ranking with its spread', () => {
    const ranking = aggregateEspnRankings([entry(6, 3, 0), entry(8, 5, 0), entry(9, 6, 0), entry(7, 7, 0)], 'QB', 'PPR', 4, '2026-09-29T00:00:00.000Z', false);
    expect(ranking).toMatchObject({ positionRank: 8, expertCount: 4, rankMin: 6, rankMax: 9, week: 4, scoringType: 'PPR', overallRank: null });
  });

  it('ignores other positions, the other scoring format and invalid ranks', () => {
    const ranking = aggregateEspnRankings([entry(3, 3, 4), entry(20, 5, 0, 'STANDARD'), entry(0, 6, 0), entry(12, 7, 0)], 'QB', 'PPR', 4, null, false);
    expect(ranking).toMatchObject({ positionRank: 12, expertCount: 1 });
  });

  it('returns null (never a made-up rank) when no expert ranks the player, and marks stale copies', () => {
    expect(aggregateEspnRankings([entry(3, 3, 4)], 'QB', 'PPR', 4, null, false)).toBeNull();
    expect(aggregateEspnRankings([], 'WR', 'PPR', 4, null, false)).toBeNull();
    expect(aggregateEspnRankings([entry(3, 3, 4)], 'WR', 'PPR', 4, null, true)?.stale).toBe(true);
  });
});
