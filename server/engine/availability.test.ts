import { describe, expect, it } from 'vitest';
import { availabilityPlayer } from '../fixtures/leagues.js';
import { assessAvailability, availabilityFields, classifyNews, playProbability, practiceLevel } from './availability.js';
import type { SleeperPlayer } from '../../shared/types.js';

const NOW = new Date('2026-09-29T12:00:00.000Z');
const base = (over: Partial<SleeperPlayer>): SleeperPlayer => ({ player_id: 'p', full_name: 'P', team: 'NYJ', position: 'RB', active: true, ...over });
const assess = (sleeper: SleeperPlayer, extra: Partial<Parameters<typeof assessAvailability>[0]> = {}) => assessAvailability({
  sleeper, news: [], sleeperRetrievedAt: '2026-09-29T11:59:00.000Z', sleeperStale: false, officialRetrievedAt: null, officialStale: false, gameTime: null, now: NOW, ...extra
});

describe('news and practice classification', () => {
  it('reads explicit negative and positive news, and leaves everything else neutral', () => {
    expect(classifyNews({ headline: 'RB is week-to-week', summary: null })).toBe('negative');
    expect(classifyNews({ headline: 'WR ruled out for Sunday', summary: null })).toBe('negative');
    expect(classifyNews({ headline: 'RB expected to play Sunday', summary: null })).toBe('positive');
    expect(classifyNews({ headline: 'RB signs extension', summary: 'Contract news' })).toBe('neutral');
  });

  it('normalizes practice participation', () => {
    expect(practiceLevel('Did Not Participate In Practice')).toBe('dnp');
    expect(practiceLevel('Limited Participation in Practice')).toBe('limited');
    expect(practiceLevel('Full Participation in Practice')).toBe('full');
    expect(practiceLevel(null)).toBeNull();
  });
});

describe('deterministic availability policy', () => {
  it('OUT / IR / PUP / SUSPENDED never play; ACTIVE plays normally', () => {
    for (const status of ['OUT', 'IR', 'PUP', 'SUSPENDED'] as const) expect(playProbability(status, null, 'neutral').value).toBe(0);
    expect(playProbability('ACTIVE', null, 'neutral').value).toBe(1);
  });

  it('DOUBTFUL takes a strong penalty', () => {
    expect(playProbability('DOUBTFUL', null, 'neutral').value).toBe(0.25);
    expect(playProbability('DOUBTFUL', null, 'positive').value).toBe(0.4);
  });

  it('QUESTIONABLE is a modest haircut alone and only moves with practice or news evidence', () => {
    expect(playProbability('QUESTIONABLE', null, 'neutral').value).toBe(0.85);
    expect(playProbability('QUESTIONABLE', 'full', 'neutral').value).toBe(0.95);
    expect(playProbability('QUESTIONABLE', 'limited', 'neutral').value).toBe(0.8);
    expect(playProbability('QUESTIONABLE', 'dnp', 'neutral').value).toBe(0.5);
    expect(playProbability('QUESTIONABLE', 'limited', 'negative').value).toBe(0.5);
    expect(playProbability('QUESTIONABLE', 'dnp', 'positive').value).toBe(0.95);
  });
});

describe('availability assessment', () => {
  it('carries status, injury, source, timestamps and confidence for an OUT player, and excludes him', () => {
    const a = assess(base({ injury_status: 'Out', injury_body_part: 'Knee', news_updated: Date.parse('2026-09-28T20:20:00Z') }),
      { news: [{ source: 'ESPN', headline: 'RB is week-to-week with a knee injury', summary: null, url: null, publishedAt: '2026-09-28T21:00:00Z' }] });
    expect(a.status).toBe('OUT');
    expect(a.injury).toBe('Knee');
    expect(a.riskFlag).toBe('EXCLUDED');
    expect(a.playProbability).toBe(0);
    expect(a.statusSource).toBe('Sleeper');
    expect(a.statusUpdatedAt).toBe('2026-09-28T20:20:00.000Z');
    expect(a.retrievedAt).toBe('2026-09-28T11:59:00.000Z'.replace('09-28', '09-29'));
    expect(a.latestNews?.headline).toContain('week-to-week');
    expect(a.confidence).toBe('High');
  });

  it('a lone Questionable label gets Medium confidence and a WATCH flag, not an exclusion', () => {
    const a = assess(base({ injury_status: 'Questionable' }));
    expect(a.status).toBe('QUESTIONABLE');
    expect(a.playProbability).toBe(0.85);
    expect(a.riskFlag).toBe('WATCH');
    expect(a.confidence).toBe('Medium');
  });

  it('marks confidence Low when the injury source could only be served from a stale cache', () => {
    const a = assess(base({ injury_status: 'Out' }), { sleeperStale: true });
    expect(a.sourceStale).toBe(true);
    expect(a.confidence).toBe('Low');
  });

  it('flags games that have already kicked off', () => {
    expect(assess(base({}), { gameTime: '2026-09-27T17:00:00.000Z' }).gameStarted).toBe(true);
    expect(assess(base({}), { gameTime: '2026-10-04T17:00:00.000Z' }).gameStarted).toBe(false);
  });

  it('never edits the published projection; expected points is a separate derived field', () => {
    const player = availabilityPlayer('hall', 'RB', 16, { status: 'Questionable', practice: 'Limited Participation in Practice' });
    expect(player.weeklyPoints).toBe(16);
    expect(player.expectedPoints).toBe(12.8);
    expect(player.availability?.playProbability).toBe(0.8);
    const out = availabilityFields(16, assess(base({ injury_status: 'Out' })));
    expect(out.eligible).toBe(false);
    expect(out.expectedPoints).toBe(0);
    expect(availabilityFields(null, assess(base({}))).expectedPoints).toBeNull();
  });
});
