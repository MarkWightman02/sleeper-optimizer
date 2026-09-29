import type { LineupEntry, MatchupTeamLine, PlayerEvaluation, PositionEdge, TransactionRecommendation, UncertainStarter, UncertaintyProfile, WaiverMatchupNote } from '../../shared/types.js';
import { candidateRelationship } from './correlation.js';

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Differences smaller than this (points or starters) are treated as even when comparing the two sides' uncertainty. */
export const UNCERTAINTY_EVEN_THRESHOLD = 1;

export const WIN_PROBABILITY_NOTE = 'No win probability is shown: the only distribution available is a point projection per player, and a calibrated variance model would have to be invented.';

/** A starter counts toward a total only when we know what he is worth: excluded players are a known 0, missing projections are unknown. */
const excluded = (player: PlayerEvaluation): boolean => player.availability?.playProbability === 0;
const known = (player: PlayerEvaluation | null): boolean => Boolean(player) && (player!.weeklyPoints != null || excluded(player!));
const expectedValue = (player: PlayerEvaluation): number => excluded(player) ? 0 : (player.expectedPoints ?? player.weeklyPoints ?? 0);

export interface LineupTotals { expected: number | null; published: number | null; missing: string[] }

export function lineupTotals(lineup: LineupEntry[]): LineupTotals {
  const missing = lineup.filter(entry => !known(entry.player)).map(entry => entry.player ? `${entry.player.name} (${entry.slot})` : `${entry.slot} (empty)`);
  if (!lineup.length || missing.length) return { expected: null, published: null, missing };
  const expected = round2(lineup.reduce((sum, entry) => sum + expectedValue(entry.player!), 0));
  const published = lineup.every(entry => entry.player!.weeklyPoints != null) ? round2(lineup.reduce((sum, entry) => sum + entry.player!.weeklyPoints!, 0)) : null;
  return { expected, published, missing };
}

export function statusDetail(player: PlayerEvaluation | null): string | null {
  const availability = player?.availability;
  if (!availability || availability.status === 'ACTIVE') return null;
  const parts = [availability.rawStatus || availability.status];
  if (availability.injury) parts.push(availability.injury);
  if (availability.playProbability != null) parts.push(`${Math.round(availability.playProbability * 100)}% to play`);
  return parts.join(' · ');
}

export function matchupLine(entry: { slot: string; player: PlayerEvaluation | null }): MatchupTeamLine {
  const player = entry.player;
  return {
    slot: entry.slot, playerId: player?.playerId || null, name: player?.name || 'No eligible player', positions: player?.positions || [],
    team: player?.team || null, opponent: player?.opponent || null, weeklyPoints: player?.weeklyPoints ?? null,
    expectedPoints: player?.expectedPoints ?? null, playProbability: player?.availability?.playProbability ?? null,
    status: player?.normalizedInjuryStatus || null, statusDetail: statusDetail(player), confidence: player?.confidence || 'Unavailable'
  };
}

const groupOf = (slot: string): string => slot === 'DST' ? 'DEF' : slot;

export function positionEdges(mine: LineupEntry[], opponent: LineupEntry[]): PositionEdge[] {
  const groups = [...new Set([...mine, ...opponent].map(entry => groupOf(entry.slot)))];
  const collect = (lineup: LineupEntry[], group: string) => {
    const entries = lineup.filter(entry => groupOf(entry.slot) === group);
    const complete = entries.length > 0 && entries.every(entry => known(entry.player));
    return {
      total: complete ? round2(entries.reduce((sum, entry) => sum + expectedValue(entry.player!), 0)) : null,
      players: entries.flatMap(entry => entry.player ? [entry.player.name] : [])
    };
  };
  return groups.map(group => {
    const a = collect(mine, group);
    const b = collect(opponent, group);
    return { group, mine: a.total, opponent: b.total, difference: a.total != null && b.total != null ? round2(a.total - b.total) : null, myPlayers: a.players, opponentPlayers: b.players };
  });
}

export function largestEdges(edges: PositionEdge[], direction: 'advantage' | 'disadvantage', limit = 2, minimum = 0.5): PositionEdge[] {
  return edges
    .filter(edge => edge.difference != null && (direction === 'advantage' ? edge.difference >= minimum : edge.difference <= -minimum))
    .sort((a, b) => direction === 'advantage' ? b.difference! - a.difference! : a.difference! - b.difference!)
    .slice(0, limit);
}

export function uncertainStarters(mine: LineupEntry[], opponent: LineupEntry[]): UncertainStarter[] {
  const collect = (lineup: LineupEntry[], side: 'mine' | 'opponent') => lineup.flatMap(entry => {
    const player = entry.player;
    const availability = player?.availability;
    if (!player || !availability || (availability.status === 'ACTIVE' && (availability.playProbability ?? 1) >= 1)) return [];
    return [{ side, playerId: player.playerId, name: player.name, slot: entry.slot, status: availability.status, playProbability: availability.playProbability, weeklyPoints: player.weeklyPoints, detail: statusDetail(player) || availability.status }];
  });
  return [...collect(mine, 'mine'), ...collect(opponent, 'opponent')];
}

export function uncertaintyProfile(lineup: LineupEntry[]): UncertaintyProfile {
  let availabilityExposure = 0;
  let lowerConfidenceStarters = 0;
  let unprojectedStarters = 0;
  for (const { player } of lineup) {
    if (!player) { unprojectedStarters += 1; continue; }
    if (player.weeklyPoints == null) { if (!excluded(player)) unprojectedStarters += 1; }
    else availabilityExposure += player.weeklyPoints * (1 - (player.availability?.playProbability ?? 1));
    if (player.confidence !== 'High') lowerConfidenceStarters += 1;
  }
  return { availabilityExposure: round2(availabilityExposure), lowerConfidenceStarters, unprojectedStarters };
}

export function compareUncertainty(mine: UncertaintyProfile, opponent: UncertaintyProfile): { moreUncertain: 'mine' | 'opponent' | 'even' | 'unclear'; explanation: string } {
  const lean = (a: number, b: number): 'mine' | 'opponent' | 'even' => Math.abs(a - b) < UNCERTAINTY_EVEN_THRESHOLD ? 'even' : a > b ? 'mine' : 'opponent';
  const signals = [lean(mine.availabilityExposure, opponent.availabilityExposure), lean(mine.lowerConfidenceStarters, opponent.lowerConfidenceStarters), lean(mine.unprojectedStarters, opponent.unprojectedStarters)];
  const sides = new Set(signals.filter(signal => signal !== 'even'));
  const moreUncertain = sides.size === 0 ? 'even' : sides.size === 2 ? 'unclear' : [...sides][0] as 'mine' | 'opponent';
  const describe = (profile: UncertaintyProfile) => `${profile.availabilityExposure.toFixed(1)} projected points at risk from availability, ${profile.lowerConfidenceStarters} starter${profile.lowerConfidenceStarters === 1 ? '' : 's'} below High data confidence, ${profile.unprojectedStarters} without a projection`;
  const verdict = moreUncertain === 'even' ? 'The two lineups carry about the same uncertainty.' : moreUncertain === 'unclear' ? 'The uncertainty measures point in different directions, so neither side is clearly more uncertain.' : `${moreUncertain === 'mine' ? 'Your' : "Your opponent's"} lineup carries more projection uncertainty.`;
  return { moreUncertain, explanation: `${verdict} You: ${describe(mine)}. Opponent: ${describe(opponent)}. Differences under ${UNCERTAINTY_EVEN_THRESHOLD} point or starter count as even; this compares data quality and availability, not a win probability.` };
}

/** Supporting context only: relates the most-considered waiver adds to the opponent's lineup. It never changes a verdict. */
export function waiverMatchupNotes(considered: TransactionRecommendation[], opponentStarters: PlayerEvaluation[], limit = 5): WaiverMatchupNote[] {
  const notes: WaiverMatchupNote[] = [];
  for (const transaction of considered.slice(0, limit)) {
    const relationship = candidateRelationship(transaction.add, opponentStarters);
    if (!relationship) continue;
    notes.push({ add: transaction.add.name, drop: transaction.drop.name, note: `${relationship} Supporting context only: it does not change the waiver verdict.` });
  }
  return notes;
}
