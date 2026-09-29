import { describe, expect, it } from 'vitest';
import { combineProjections, computeConfidence, computeDataConfidence, rankingsAgree, type ConfidenceInputs } from './consensus.js';

const ranking = { expertCount: 6, rankMin: 10, rankMax: 14, positionRank: 12 };
const base: ConfidenceInputs = {
  projections: [{ points: 15, coverage: 95 }], rankings: [ranking], projectionPositionRank: 11,
  mappingConfidence: 'exact', normalizedInjuryStatus: 'ACTIVE', availabilityConfidence: 'High'
};

describe('projection consensus', () => {
  it('averages every published numeric projection transparently', () => {
    const result = combineProjections([
      { source: 'A', points: 16.2, coverage: 100, retrievedAt: null },
      { source: 'B', points: 14.8, coverage: 90, retrievedAt: null },
      { source: 'C', points: 15.6, coverage: 80, retrievedAt: null }
    ]);
    expect(result.points).toBe(15.53);
  });

  it('returns null rather than a fabricated value when no source projected the player', () => {
    expect(combineProjections([]).points).toBeNull();
  });
});

describe('data-quality confidence', () => {
  it('is Unavailable with no evidence and Low with only a ranking', () => {
    expect(computeConfidence({ ...base, projections: [], rankings: [] }).level).toBe('Unavailable');
    expect(computeConfidence({ ...base, projections: [] }).level).toBe('Low');
  });

  it('allows High for a single fresh, well-covered, exactly mapped source that experts corroborate', () => {
    const result = computeConfidence(base);
    expect(result.level).toBe('High');
    expect(result.reasons.join(' ')).toContain('Only one numeric projection source');
  });

  it('caps a single source at Medium when nothing corroborates it', () => {
    expect(computeConfidence({ ...base, rankings: [], projectionPositionRank: null }).level).toBe('Medium');
  });

  it('never gives High to a stale source, however good the rest looks', () => {
    expect(computeConfidence({ ...base, projections: [{ points: 15, coverage: 100, stale: true }] }).level).toBe('Low');
  });

  it('never gives High to a low-coverage source', () => {
    expect(computeConfidence({ ...base, projections: [{ points: 9, coverage: 40 }] }).level).toBe('Low');
  });

  it('caps at Medium for a fuzzy identity match, injury uncertainty, or a news conflict', () => {
    expect(computeConfidence({ ...base, mappingConfidence: 'medium' }).level).not.toBe('High');
    expect(computeConfidence({ ...base, normalizedInjuryStatus: 'QUESTIONABLE' }).level).not.toBe('High');
    expect(computeConfidence({ ...base, availabilityConfidence: 'Low' }).level).not.toBe('High');
    expect(computeConfidence({ ...base, newsConflict: true }).level).not.toBe('High');
  });

  it('drops confidence when the league projection contradicts the expert rank', () => {
    const result = computeConfidence({ ...base, projectionPositionRank: 60 });
    expect(result.level).not.toBe('High');
    expect(result.reasons.join(' ')).toContain('experts have #12');
  });

  it('is Low when the identity is unmapped or ambiguous', () => {
    expect(computeConfidence({ ...base, mappingConfidence: 'ambiguous' }).level).toBe('Low');
  });

  it('penalizes wide disagreement between numeric sources even with several of them', () => {
    const agreeing = computeConfidence({ ...base, projections: [{ points: 15, coverage: 90 }, { points: 15.2, coverage: 90 }, { points: 14.9, coverage: 90 }] });
    const disagreeing = computeConfidence({ ...base, projections: [{ points: 8, coverage: 90 }, { points: 15, coverage: 90 }, { points: 22, coverage: 90 }] });
    expect(disagreeing.score).toBeLessThan(agreeing.score);
    expect(disagreeing.level).not.toBe('High');
  });

  it('judges ranking agreement only with enough experts', () => {
    expect(rankingsAgree({ expertCount: 2, rankMin: 1, rankMax: 2, positionRank: 1 })).toBeNull();
    expect(rankingsAgree({ expertCount: 5, rankMin: 5, rankMax: 40, positionRank: 12 })).toBe(false);
  });
});

describe('run-level data confidence', () => {
  const ok = (name: string, kind: string, extra: object = {}) => ({ name, kind, status: 'SUCCESS', ...extra });
  const starters = (confidence: 'High' | 'Medium' | 'Low', count = 4) => Array.from({ length: count }, (_, i) => ({ name: `P${i}`, confidence, weeklyPoints: 10 }));
  const sources = [ok('ESPN', 'projection'), ok('nflverse injuries', 'injury'), ok('Sleeper', 'injury'), ok('ESPN NFL News', 'news')];

  it('is High only when every source is fresh and the starters are well supported', () => {
    const result = computeDataConfidence({ outcomes: sources, starters: starters('High') });
    expect(result.level).toBe('High');
    expect(result).toMatchObject({ sourcesSuccessful: 4, sourcesAttempted: 4, sourcesStale: 0 });
  });

  it('a stale or failed projection source forces Low no matter how good the starters look', () => {
    expect(computeDataConfidence({ outcomes: [ok('ESPN', 'projection', { stale: true }), ...sources.slice(1)], starters: starters('High') }).level).toBe('Low');
    expect(computeDataConfidence({ outcomes: [{ name: 'ESPN', kind: 'projection', status: 'BLOCKED' }, ...sources.slice(1)], starters: starters('High') }).level).toBe('Low');
  });

  it('a failed injury or news source caps at Medium, and weak starters cap the run', () => {
    expect(computeDataConfidence({ outcomes: [...sources.slice(0, 3), { name: 'ESPN NFL News', kind: 'news', status: 'FAILED' }], starters: starters('High') }).level).toBe('Medium');
    expect(computeDataConfidence({ outcomes: [ok('ESPN', 'projection'), { name: 'nflverse injuries', kind: 'injury', status: 'FAILED' }, ok('Sleeper', 'injury')], starters: starters('High') }).level).toBe('Medium');
    expect(computeDataConfidence({ outcomes: sources, starters: [...starters('High', 3), ...starters('Low', 1)] }).level).toBe('Medium');
    expect(computeDataConfidence({ outcomes: sources, starters: starters('Low', 4) }).level).toBe('Low');
  });
});
