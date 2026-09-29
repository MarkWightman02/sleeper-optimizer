import { describe, expect, it } from 'vitest';
import { combineProjections, computeConfidence } from './consensus.js';

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

describe('confidence scoring', () => {
  it('is Unavailable with no evidence at all', () => {
    expect(computeConfidence({ projectionValues: [], rankingCount: 0, mappingConfidence: 'unmapped', normalizedInjuryStatus: 'ACTIVE', coverage: 0 })).toBe('Unavailable');
  });

  it('is High with multiple agreeing sources, exact mapping, full coverage, and no injury concern', () => {
    expect(computeConfidence({ projectionValues: [16, 15.6, 15.8], rankingCount: 2, mappingConfidence: 'exact', normalizedInjuryStatus: 'ACTIVE', coverage: 95 })).toBe('High');
  });

  it('is Low with a single source, conflicting rankings assumption, and a doubtful tag', () => {
    expect(computeConfidence({ projectionValues: [12], rankingCount: 0, mappingConfidence: 'medium', normalizedInjuryStatus: 'DOUBTFUL', coverage: 40 })).toBe('Low');
  });

  it('penalizes wide disagreement between numeric sources even with several of them', () => {
    const agreeing = computeConfidence({ projectionValues: [15, 15.2, 14.9], rankingCount: 0, mappingConfidence: 'high', normalizedInjuryStatus: 'ACTIVE', coverage: 90 });
    const disagreeing = computeConfidence({ projectionValues: [8, 15, 22], rankingCount: 0, mappingConfidence: 'high', normalizedInjuryStatus: 'ACTIVE', coverage: 90 });
    const rank = { High: 3, Medium: 2, Low: 1, Unavailable: 0 } as const;
    expect(rank[disagreeing]).toBeLessThan(rank[agreeing]);
  });
});
