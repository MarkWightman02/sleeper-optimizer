import type { PlayerEvaluation, SleeperPlayer, SleeperRoster } from '../../shared/types.js';
import { assessAvailability, availabilityFields } from '../engine/availability.js';

export function fixturePlayer(id: string, position: string, points: number | null, options: Partial<PlayerEvaluation> = {}): PlayerEvaluation {
  return {
    playerId: id, name: id, team: 'TST', positions: [position], status: 'Active', injuryStatus: null,
    opponent: 'OPP', gameTime: '2026-09-27T13:00:00-04:00', weeklyPoints: points,
    restOfSeasonValue: null, confidence: points == null ? 'Unavailable' : 'High', rosterStatus: 'bench',
    eligible: true, projections: [], rankings: [], newsItems: [], supportingData: [], metrics: {}, reasons: [], ...options
  };
}

export const flexFixture = {
  rosterPositions: ['WR', 'FLEX', 'BN'],
  players: [fixturePlayer('WR_A', 'WR', 10), fixturePlayer('RB_A', 'RB', 9), fixturePlayer('WR_B', 'WR', 8)]
};

export const superFlexFixture = {
  rosterPositions: ['QB', 'SUPER_FLEX', 'RB', 'BN'],
  players: [fixturePlayer('QB_A', 'QB', 20), fixturePlayer('QB_B', 'QB', 18), fixturePlayer('RB_A', 'RB', 12), fixturePlayer('WR_A', 'WR', 11)]
};

export const ownershipFixture: { players: Record<string, SleeperPlayer>; rosters: SleeperRoster[] } = {
  players: {
    owned: { player_id: 'owned', full_name: 'Owned Player', team: 'TST', position: 'RB', active: true },
    reserve: { player_id: 'reserve', full_name: 'Reserve Player', team: 'TST', position: 'WR', active: true },
    taxi: { player_id: 'taxi', full_name: 'Taxi Player', team: 'TST', position: 'TE', active: true },
    available: { player_id: 'available', full_name: 'Available Player', team: 'TST', position: 'QB', active: true },
    retired: { player_id: 'retired', full_name: 'Retired Player', team: null, position: 'RB', active: false }
  },
  rosters: [{ roster_id: 1, owner_id: 'u1', players: ['owned'], starters: ['owned'], reserve: ['reserve'], taxi: ['taxi'] }]
};

export interface AvailabilityFixture {
  status?: string | null;
  practice?: string | null;
  injury?: string | null;
  news?: Array<{ headline: string; summary?: string; publishedAt?: string; source?: string }>;
  updatedAt?: string;
  retrievedAt?: string;
  stale?: boolean;
  gameTime?: string | null;
}

/** Builds a player through the real availability pipeline (assessAvailability → availabilityFields), like `makeEvaluation` does. */
export function availabilityPlayer(id: string, position: string, points: number | null, fixture: AvailabilityFixture = {}, options: Partial<PlayerEvaluation> = {}): PlayerEvaluation {
  const retrievedAt = fixture.retrievedAt ?? '2026-09-29T12:00:00.000Z';
  const availability = assessAvailability({
    sleeper: { player_id: id, full_name: id, position, team: 'TST', active: true, injury_status: fixture.status ?? null, injury_body_part: fixture.injury ?? null, practice_participation: fixture.practice ?? null, news_updated: fixture.updatedAt ? Date.parse(fixture.updatedAt) : undefined } as SleeperPlayer,
    news: (fixture.news || []).map(item => ({ source: item.source || 'ESPN', headline: item.headline, summary: item.summary ?? null, url: null, publishedAt: item.publishedAt || null })),
    sleeperRetrievedAt: retrievedAt, sleeperStale: fixture.stale ?? false, officialRetrievedAt: null, officialStale: false,
    gameTime: fixture.gameTime ?? null, now: new Date('2026-09-29T12:00:00.000Z')
  });
  const derived = availabilityFields(points, availability);
  return fixturePlayer(id, position, points, { ...options, availability: derived.availability, expectedPoints: derived.expectedPoints, eligible: derived.eligible, injuryStatus: fixture.status ?? null });
}
