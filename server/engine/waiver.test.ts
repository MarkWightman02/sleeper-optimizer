import { describe, expect, it } from 'vitest';
import type { Acquisition, PlayerEvaluation, RoleEvidence, WaiverRules } from '../../shared/types.js';
import { availabilityPlayer, fixturePlayer } from '../fixtures/leagues.js';
import { NO_CLAIM_HEADLINE, searchTransactions } from './optimizer.js';
import { assessRole } from './role.js';
import { inferAcquisition, inferWaiverRules, priorityFactor, recentDropsFromTransactions, waiverCost, WAIVER_MODEL } from './waiver.js';

const FREE_AGENT: Acquisition = { kind: 'FREE_AGENT', reason: 'instant add (test)' };
const CLAIM: Acquisition = { kind: 'WAIVER_CLAIM', reason: 'game already kicked off (test)' };
const rules = (priorityPosition: number): WaiverRules => ({ type: 'ROLLING', clearDays: 2, priorityPosition, teams: 10, transactionsLoaded: true, notes: [] });

const durable = () => assessRole({ position: 'RB', depthRank: 1, snapPct: 70, recentUsage: null, teammatesAhead: [] });
const moderate = () => assessRole({ position: 'RB', depthRank: 2, snapPct: 55, recentUsage: null, teammatesAhead: [] });
const fillIn = () => assessRole({ position: 'RB', depthRank: 2, snapPct: 55, recentUsage: null, teammatesAhead: [{ name: 'Starter', status: 'OUT' }] });
const limited = () => assessRole({ position: 'RB', depthRank: 3, snapPct: 20, recentUsage: null, teammatesAhead: [] });

function player(id: string, position: string, points: number | null, extra: Partial<PlayerEvaluation> = {}): PlayerEvaluation {
  return fixturePlayer(id, position, points, { projectionCoverage: 100, mappingConfidence: 'exact', ...extra });
}
const free = (id: string, points: number, acquisition: Acquisition, role: RoleEvidence, extra: Partial<PlayerEvaluation> = {}) =>
  player(id, 'RB', points, { rosterStatus: 'free_agent', acquisition, role, ...extra });

/** One RB slot: a starter at 8 and a bench RB that is the natural drop. `add` projects `8 + gain`. */
function run(gain: number, acquisition: Acquisition, role: RoleEvidence, options: { priority?: number; drop?: PlayerEvaluation; addExtra?: Partial<PlayerEvaluation> } = {}) {
  const roster = [player('starter', 'RB', 8, { rosterStatus: 'starter', role: durable() }), options.drop ?? player('bench', 'RB', 2, { role: limited() })];
  const result = searchTransactions(roster, [free('add', 8 + gain, acquisition, role, options.addExtra)], ['RB', 'BN'], ['starter'], { week: 4, waiverRules: rules(options.priority ?? 5) });
  const move = result.transactions[0] ?? result.considered[0];
  return { result, move, assessment: move.assessment! };
}

describe('waiver decisions default to holding', () => {
  it('a +2 gain with no rest-of-season evidence resolves to HOLD', () => {
    const { result, move } = run(2, CLAIM, moderate());
    expect(result.transactions).toHaveLength(0);
    expect(move.tier).toBe('HOLD');
    expect(result.summary.decision).toBe('HOLD');
    expect(result.summary.headline).toBe(NO_CLAIM_HEADLINE);
  });

  it('a +3 to +4 gain with a valuable drop resolves to HOLD', () => {
    const valuable = player('bench', 'RB', 7.5, { role: durable() });
    for (const gain of [3, 4]) {
      const { result, move } = run(gain, FREE_AGENT, moderate(), { drop: valuable });
      expect(result.transactions).toHaveLength(0);
      expect(['HOLD', 'OPTIONAL']).toContain(move.tier);
      expect(move.assessment!.drop.cost).toBeGreaterThan(1);
    }
  });

  it('a useful drop candidate protects against a bad move that a worthless drop would allow', () => {
    const worthless = run(5, FREE_AGENT, moderate());
    expect(['CLAIM', 'STRONG CLAIM']).toContain(worthless.move.tier);
    const useful = run(5, FREE_AGENT, moderate(), { drop: player('bench', 'RB', 7.5, { role: durable() }) });
    expect(useful.result.transactions).toHaveLength(0);
    expect(useful.assessment.net).toBeLessThan(worthless.assessment.net);
    expect(useful.assessment.drop.cost).toBeGreaterThan(worthless.assessment.drop.cost);
  });

  it('a large gain justifies a claim even with waiver priority at stake', () => {
    const { result, move } = run(12, CLAIM, assessRole({ position: 'RB', depthRank: null, snapPct: null, recentUsage: null, teammatesAhead: [] }));
    expect(['CLAIM', 'STRONG CLAIM']).toContain(move.tier);
    expect(result.transactions).toHaveLength(1);
    expect(result.summary.decision).toBe('MOVE');
  });

  it('a durable role upgrade can justify a claim that a temporary fill-in role does not', () => {
    const durableMove = run(5, CLAIM, durable());
    const fillInMove = run(5, CLAIM, fillIn());
    expect(['CLAIM', 'STRONG CLAIM']).toContain(durableMove.move.tier);
    expect(['HOLD', 'OPTIONAL', 'SPECULATIVE']).toContain(fillInMove.move.tier);
    expect(fillInMove.assessment.net).toBeLessThan(durableMove.assessment.net);
    expect(fillInMove.assessment.required.claim).toBeGreaterThan(durableMove.assessment.required.claim);
  });

  it('a small gain can still clear the bar when it fixes an urgent injury-driven hole', () => {
    const hurt = availabilityPlayer('hurt', 'RB', 10, { status: 'Out' }, { role: durable(), projectionCoverage: 100, mappingConfidence: 'exact' });
    const roster = [hurt];
    const add = free('add', 3, FREE_AGENT, moderate());
    const result = searchTransactions(roster, [add], ['RB', 'BN'], [], { week: 4, waiverRules: rules(5) });
    const move = result.transactions[0] ?? result.considered[0];
    expect(move.assessment!.need.credit).toBeGreaterThan(0);
    expect(['CLAIM', 'STRONG CLAIM']).toContain(move.tier);

    const noNeed = run(3, FREE_AGENT, moderate());
    expect(noNeed.move.tier).not.toBe('CLAIM');
    expect(noNeed.result.transactions).toHaveLength(0);
  });
});

describe('waiver cost under rolling waivers', () => {
  it('holds a waiver claim to a stricter standard than an instant free-agent add', () => {
    const asFreeAgent = run(4.5, FREE_AGENT, moderate());
    const asClaim = run(4.5, CLAIM, moderate());
    expect(asFreeAgent.assessment.waiver.cost).toBe(0);
    expect(asClaim.assessment.waiver.cost).toBeGreaterThan(0);
    expect(asClaim.assessment.net).toBeLessThan(asFreeAgent.assessment.net);
    expect(asClaim.assessment.breakEvenWeeklyGain).toBeGreaterThan(asFreeAgent.assessment.breakEvenWeeklyGain);
    expect(['CLAIM', 'STRONG CLAIM']).toContain(asFreeAgent.move.tier);
    expect(['CLAIM', 'STRONG CLAIM']).not.toContain(asClaim.move.tier);
  });

  it('spending a better waiver priority costs more, and can change the recommendation', () => {
    const front = run(5.5, CLAIM, moderate(), { priority: 1 });
    const back = run(5.5, CLAIM, moderate(), { priority: 10 });
    expect(front.assessment.waiver.cost).toBeGreaterThan(back.assessment.waiver.cost);
    expect(front.result.transactions).toHaveLength(0);
    expect(back.result.transactions).toHaveLength(1);
  });

  it('prices a claim with unknown acquisition status like a claim', () => {
    const unknown = run(4.5, { kind: 'UNKNOWN', reason: 'transactions unavailable' }, moderate());
    expect(unknown.assessment.waiver.cost).toBeGreaterThan(0);
  });

  it('priority factor and cost are deterministic and bounded', () => {
    expect(priorityFactor(rules(1))).toBe(1);
    expect(priorityFactor(rules(10))).toBeCloseTo(WAIVER_MODEL.priorityFloor);
    expect(priorityFactor(null)).toBe(1);
    expect(waiverCost('FREE_AGENT', rules(1))).toBe(0);
    expect(waiverCost('WAIVER_CLAIM', rules(1))).toBe(WAIVER_MODEL.claimCostBase);
  });
});

describe('long-term evidence', () => {
  it('treats unavailable rest-of-season value as insufficient evidence, not zero and not certainty', () => {
    const unknown = run(4, FREE_AGENT, moderate());
    expect(unknown.assessment.longTerm.status).toBe('INSUFFICIENT');
    expect(unknown.assessment.longTerm.rosGainPerWeek).toBeNull();
    expect(unknown.assessment.longTerm.credit).toBeNull();
    expect(unknown.assessment.longTerm.note).toContain('Unavailable');
    expect(unknown.assessment.required.claim).toBeGreaterThan(WAIVER_MODEL.claim);
    expect(unknown.assessment.required.adjustments.join(' ')).toContain('no rest-of-season evidence');

    const known = run(4, FREE_AGENT, moderate(), { addExtra: { restOfSeasonValue: 150 }, drop: player('bench', 'RB', 2, { role: limited(), restOfSeasonValue: 20 }) });
    expect(known.assessment.longTerm.status).toBe('AVAILABLE');
    expect(known.assessment.required.claim).toBeLessThan(unknown.assessment.required.claim);
  });

  it('documents every required section for each transaction', () => {
    const { assessment } = run(4, CLAIM, moderate());
    expect(assessment.sections.map(section => section.label)).toEqual(expect.arrayContaining(['WEEKLY IMPACT', 'LONG-TERM VALUE', 'DROP COST', 'WAIVER COST', 'CONFIDENCE', 'RECOMMENDATION', 'WHY']));
  });
});

describe('no transaction is a valid outcome', () => {
  it('holds when the free-agent pool cannot help', () => {
    const roster = [player('starter', 'RB', 8, { rosterStatus: 'starter' }), player('bench', 'RB', 2)];
    const result = searchTransactions(roster, [], ['RB', 'BN'], ['starter'], { week: 4, waiverRules: rules(5) });
    expect(result.transactions).toHaveLength(0);
    expect(result.summary.decision).toBe('HOLD');
    expect(result.summary.headline).toBe(NO_CLAIM_HEADLINE);
  });

  it('picks doing nothing over the best small-gain alternative and explains why', () => {
    const { result } = run(3.4, CLAIM, assessRole({ position: 'RB', depthRank: 1, snapPct: 30, recentUsage: null, teammatesAhead: [] }), { drop: player('bench', 'RB', 6, { role: moderate() }) });
    expect(result.transactions).toHaveLength(0);
    expect(result.summary.bestConsidered?.add).toBe('add');
    expect(result.summary.why).toContain('Holding');
  });
});

describe('acquisition inference', () => {
  const games = [{ season: '2026', week: '3', home_team: 'AAA', away_team: 'BBB', gameday: '2026-09-21', gametime: '13:00' }] as never;
  const base = { playerId: 'p', now: new Date('2026-09-28T12:00:00Z'), sleeperWeek: 3, season: '2026', games, recentDrops: new Map<string, number>(), clearDays: 2, transactionsLoaded: true };

  it('treats a player whose team already played this Sleeper week as waiver-only', () => {
    expect(inferAcquisition({ ...base, team: 'AAA' }).kind).toBe('WAIVER_CLAIM');
  });

  it('treats a player dropped inside the clear window as waiver-only', () => {
    const dropped = new Map([['p', Date.parse('2026-09-27T12:00:00Z')]]);
    expect(inferAcquisition({ ...base, team: 'ZZZ', recentDrops: dropped }).kind).toBe('WAIVER_CLAIM');
    const old = new Map([['p', Date.parse('2026-09-20T12:00:00Z')]]);
    expect(inferAcquisition({ ...base, team: 'ZZZ', recentDrops: old }).kind).toBe('FREE_AGENT');
  });

  it('is UNKNOWN, not FREE_AGENT, when transactions could not be loaded', () => {
    expect(inferAcquisition({ ...base, team: 'ZZZ', transactionsLoaded: false }).kind).toBe('UNKNOWN');
  });

  it('reads recent drops from completed Sleeper transactions only', () => {
    const drops = recentDropsFromTransactions([
      { status: 'complete', drops: { a: 1 }, status_updated: 1000 }, { status: 'failed', drops: { b: 1 }, status_updated: 2000 }, { status: 'complete', drops: null, created: 3000 }
    ]);
    expect([...drops.keys()]).toEqual(['a']);
  });

  it('reads waiver rules from league settings', () => {
    const parsed = inferWaiverRules({ leagueSettings: { waiver_type: 0, waiver_clear_days: 2 }, rosterSettings: { waiver_position: 4 }, teams: 10, transactionsLoaded: true });
    expect(parsed).toMatchObject({ type: 'ROLLING', clearDays: 2, priorityPosition: 4, teams: 10 });
  });
});
