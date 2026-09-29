import { describe, expect, it } from 'vitest';
import type { LineupEntry, PlayerEvaluation } from '../../shared/types.js';
import { availabilityPlayer, type AvailabilityFixture } from '../fixtures/leagues.js';
import { correlationBonusMap } from './correlation.js';
import { attachLineupDecisions } from './decisions.js';
import { lineupExpectedTotal, lineupTotal, optimizeIfEveryonePlays, optimizeLineup } from './optimizer.js';

const POSITIONS = ['RB', 'RB'];
const BAND = 1;
const OUT_NEWS: AvailabilityFixture = {
  status: 'Out', injury: 'Knee', updatedAt: '2026-09-28T20:20:00.000Z', retrievedAt: '2026-09-29T12:00:00.000Z',
  news: [{ headline: 'Breece Hall week-to-week with a knee injury', publishedAt: '2026-09-28T21:30:00.000Z', source: 'ESPN NFL News' }]
};

/** Mirrors runAnalysis: solve with availability-aware expected points, then attach the structured decisions. */
function recommend(players: PlayerEvaluation[], positions = POSITIONS, currentIds: string[] = ['rb_a', 'hall']) {
  const byId = new Map(players.map(player => [player.playerId, player]));
  const current: LineupEntry[] = currentIds.map((id, index) => ({ slot: positions[index], player: byId.get(id) || null, changed: false, previousPlayerId: null }));
  const recommended = optimizeLineup(players.filter(player => player.eligible), positions, currentIds);
  attachLineupDecisions(current, recommended, BAND, new Map());
  return { current, recommended, ids: recommended.map(entry => entry.player?.playerId), decisions: recommended.flatMap(entry => entry.decision ? [entry.decision] : []) };
}

const roster = (hall: AvailabilityFixture, hallPoints = 16, henderson = 10.4) => [
  availabilityPlayer('rb_a', 'RB', 15),
  availabilityPlayer('hall', 'RB', hallPoints, hall),
  availabilityPlayer('henderson', 'RB', henderson)
];

describe('projection-first optimization', () => {
  it('a lower-projected healthy player cannot beat a clearly higher-projected healthy player', () => {
    const { ids, decisions } = recommend(roster({}), POSITIONS, ['rb_a', 'henderson']);
    expect(ids).toContain('hall');
    expect(ids).not.toContain('henderson');
    expect(decisions[0]?.kind).toBe('PROJECTION');
    expect(decisions[0]?.difference).toBeCloseTo(5.6, 5);
  });

  it('removing the injury concern restores the projection-optimal player', () => {
    const withInjury = recommend(roster(OUT_NEWS));
    expect(withInjury.ids).toContain('henderson');
    const healthy = recommend(roster({}));
    expect(healthy.ids).toContain('hall');
    expect(healthy.ids).not.toContain('henderson');
    expect(healthy.decisions).toHaveLength(0);
  });

  it('correlation cannot override a large gap', () => {
    const players = roster({});
    players[1] = { ...players[1], team: 'BUF' };
    const receiving = { providerStat: 'espn:53', projectedStat: null, sleeperKey: 'rec_yd', multiplier: null, projectedPoints: 8, modeled: true };
    const passing = { providerStat: 'espn:3', projectedStat: null, sleeperKey: 'pass_yd', multiplier: null, projectedPoints: 12, modeled: true };
    players[2] = { ...players[2], team: 'KC', scoringComponents: [receiving] };
    const opponent = [availabilityPlayer('their_qb', 'QB', 20, {}, { team: 'KC', scoringComponents: [passing] })];
    const bonus = correlationBonusMap(players, opponent, BAND, 'FAVORITE');
    expect(bonus.get('henderson')).toBeGreaterThan(0);
    const lineup = optimizeLineup(players, POSITIONS, [], bonus);
    expect(lineup.map(entry => entry.player?.playerId)).toContain('hall');
    expect(lineup.map(entry => entry.player?.playerId)).not.toContain('henderson');
  });
});

describe('injury designations', () => {
  it('a generic QUESTIONABLE label alone does not let a 5+ point inferior player replace someone', () => {
    const { ids } = recommend(roster({ status: 'Questionable' }));
    expect(ids).toContain('hall');
    expect(ids).not.toContain('henderson');
  });

  it('QUESTIONABLE with limited practice still starts the much higher projection', () => {
    const { ids } = recommend(roster({ status: 'Questionable', practice: 'Limited Participation in Practice' }));
    expect(ids).toContain('hall');
  });

  it('QUESTIONABLE with explicit negative news (or a missed practice) can lose to a healthy player, and says why', () => {
    const { ids, decisions } = recommend(roster({ status: 'Questionable', practice: 'Did Not Participate In Practice', news: [{ headline: 'Hall is unlikely to play Sunday', publishedAt: '2026-09-29T09:00:00.000Z' }] }));
    expect(ids).toContain('henderson');
    expect(decisions[0].kind).toBe('AVAILABILITY_DISCOUNT');
    expect(decisions[0].projectionSacrifice).toBeCloseTo(5.6, 5);
  });

  it('OUT is excluded from the recommended lineup', () => {
    const players = roster(OUT_NEWS);
    expect(players[1].eligible).toBe(false);
    expect(recommend(players).ids).not.toContain('hall');
  });

  it('DOUBTFUL takes a strong penalty: a 16 point doubtful player loses to a healthy 10.4', () => {
    const { ids, decisions } = recommend(roster({ status: 'Doubtful' }));
    expect(ids).toContain('henderson');
    expect(decisions[0].kind).toBe('AVAILABILITY_DISCOUNT');
  });

  it('DOUBTFUL is still used when nobody comparable exists', () => {
    const { ids } = recommend([availabilityPlayer('rb_a', 'RB', 15), availabilityPlayer('hall', 'RB', 16, { status: 'Doubtful' }), availabilityPlayer('scrub', 'RB', 3)]);
    expect(ids).toContain('hall');
  });
});

describe('injury override explanation', () => {
  const overridden = () => {
    const players = roster(OUT_NEWS);
    return { players, ...recommend(players) };
  };

  it('retains the original published projections', () => {
    const { players, decisions } = overridden();
    expect(players[1].weeklyPoints).toBe(16);
    expect(players[2].weeklyPoints).toBe(10.4);
    expect(decisions[0].startProjection).toBe(10.4);
    expect(decisions[0].benchProjection).toBe(16);
    expect(decisions[0].startExpected).toBe(10.4);
    expect(decisions[0].benchExpected).toBe(0);
  });

  it('states the exact projection sacrifice and never claims a globally optimal lineup', () => {
    const { decisions } = overridden();
    const decision = decisions[0];
    expect(decision.kind).toBe('AVAILABILITY_EXCLUSION');
    expect(decision.projectionSacrifice).toBeCloseTo(5.6, 5);
    const text = [decision.headline, decision.whyLowerProjection, ...decision.decisionLogic, ...decision.whatCouldChange].join('\n');
    expect(decision.headline).toContain('AVAILABILITY OVERRIDE');
    expect(decision.headline).toContain('5.6');
    expect(text).toContain('16.0');
    expect(text).toContain('10.4');
    expect(text.toLowerCase()).not.toContain('globally optimal');
    expect(text.toLowerCase()).not.toContain('preserving');
    expect(decision.whyLowerProjection).toContain('does NOT project higher');
    expect(decision.whatCouldChange.join(' ')).toContain('upgraded');
  });

  it('exposes source, timestamps, status, injury, news and confidence for the benched player', () => {
    const availability = overridden().decisions[0].benchAvailability!;
    expect(availability.status).toBe('OUT');
    expect(availability.injury).toBe('Knee');
    expect(availability.statusSource).toBe('Sleeper');
    expect(availability.statusUpdatedAt).toBe('2026-09-28T20:20:00.000Z');
    expect(availability.retrievedAt).toBe('2026-09-29T12:00:00.000Z');
    expect(availability.latestNews?.headline).toContain('week-to-week');
    expect(availability.latestNews?.source).toBe('ESPN NFL News');
    expect(availability.confidence).toBe('High');
    expect(availability.playProbability).toBe(0);
  });

  it('separates the pure-projection lineup from the availability-aware recommendation', () => {
    const { players, recommended } = overridden();
    const pure = optimizeIfEveryonePlays(players, POSITIONS, ['rb_a', 'hall']);
    expect(pure.map(entry => entry.player?.playerId)).toContain('hall');
    expect(lineupTotal(pure)).toBeCloseTo(31, 5);
    expect(lineupTotal(recommended)).toBeCloseTo(25.4, 5);
    expect(lineupTotal(pure)! - lineupTotal(recommended)!).toBeCloseTo(5.6, 5);
    expect(lineupExpectedTotal(recommended)).toBeCloseTo(25.4, 5);
  });
});

describe('pure-projection lineup with an unprojected, unavailable starter', () => {
  it('does not lock in an OUT player who has no published projection, so the totals stay comparable', () => {
    const players = [...roster(OUT_NEWS), availabilityPlayer('reed', 'WR', null, { status: 'Out' })];
    const positions = ['RB', 'RB', 'FLEX'];
    const pure = optimizeIfEveryonePlays(players, positions, ['rb_a', 'hall', 'reed']);
    expect(pure.map(entry => entry.player?.playerId).sort()).toEqual(['hall', 'henderson', 'rb_a']);
    expect(lineupTotal(pure)).toBeCloseTo(41.4, 5);
    const recommended = optimizeLineup(players.filter(player => player.eligible), positions, ['rb_a', 'hall', 'reed']);
    expect(lineupTotal(recommended)).toBeNull();
  });
});

describe('close and normal decisions resolve on projection', () => {
  it('a Wilson/DK-style near tie is a toss-up decided by projection, with no availability language', () => {
    const players = [availabilityPlayer('wr_top', 'WR', 15), availabilityPlayer('wilson', 'WR', 12.02), availabilityPlayer('dk', 'WR', 12)];
    const result = recommend(players, ['WR', 'WR'], ['wr_top', 'dk']);
    expect(result.ids).toContain('wilson');
    expect(result.decisions[0].kind).toBe('TOSS_UP');
    expect(result.decisions[0].projectionSacrifice).toBeNull();
    expect(result.decisions[0].headline.toLowerCase()).toContain('toss-up');
    expect(result.decisions[0].headline).toContain('+0.02');
  });

  it('a Kittle/Kraft-style 2.4 point edge is a normal projection decision', () => {
    const players = [availabilityPlayer('kittle', 'TE', 11.4), availabilityPlayer('kraft', 'TE', 9)];
    const result = recommend(players, ['TE'], ['kraft']);
    expect(result.ids).toEqual(['kittle']);
    expect(result.decisions[0].kind).toBe('PROJECTION');
    expect(result.decisions[0].difference).toBeCloseTo(2.4, 5);
    expect(result.decisions[0].projectionSacrifice).toBeNull();
    expect(result.decisions[0].whyLowerProjection).toBeNull();
  });

  it('a healthy-player swap inside the decision band is labelled a close call', () => {
    const players = [availabilityPlayer('a', 'TE', 10.6), availabilityPlayer('b', 'TE', 10)];
    expect(recommend(players, ['TE'], ['b']).decisions[0].kind).toBe('CLOSE_CALL');
  });
});
