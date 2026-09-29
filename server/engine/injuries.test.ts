import { describe, expect, it } from 'vitest';
import { BASE_PLAY_PROBABILITY, combineInjuryStatus, normalizeInjuryStatus } from './injuries.js';

describe('injury normalization', () => {
  it('normalizes common provider spellings', () => {
    expect(normalizeInjuryStatus('Q')).toBe('QUESTIONABLE');
    expect(normalizeInjuryStatus('Injured Reserve')).toBe('IR');
    expect(normalizeInjuryStatus('Not Starting')).toBe('OUT');
  });

  it('keeps the more severe of Sleeper vs. the official nflverse weekly report and retains practice context', () => {
    const result = combineInjuryStatus(
      { player_id: 'p1', active: true, injury_status: 'Questionable', injury_body_part: 'Ankle' },
      { gsis_id: '00-0000001', report_status: 'Doubtful', practice_status: 'Did Not Participate In Practice', report_primary_injury: 'Ankle' }
    );
    expect(result.normalized).toBe('DOUBTFUL');
    expect(result.practice).toBe('Did Not Participate In Practice');
    expect(BASE_PLAY_PROBABILITY[result.normalized]).toBe(.25);
  });

  it('accepts Sleeper news timestamps in milliseconds without multiplying them again', () => {
    const result = combineInjuryStatus({ player_id: 'p2', active: true, news_updated: 1_795_000_000_000 });
    expect(result.lastUpdated).toMatch(/^2026-/);
  });
});
