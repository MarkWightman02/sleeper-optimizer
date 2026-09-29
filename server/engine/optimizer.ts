import type { LineupEntry, PlayerEvaluation, RecommendationTier, ReplacementLevel, TransactionAssessment, TransactionRecommendation, TransactionSummary, WaiverRules } from '../../shared/types.js';
import { assessTransaction } from './waiver.js';

const NON_STARTERS = new Set(['BN', 'IR', 'TAXI']);

export function starterSlots(rosterPositions: string[]): string[] {
  return rosterPositions.filter(slot => !NON_STARTERS.has(slot));
}

export function eligibleForSlot(positions: string[], slot: string): boolean {
  const normalized = positions.map(position => position === 'DST' ? 'DEF' : position);
  const target = slot === 'DST' ? 'DEF' : slot;
  if (normalized.includes(target)) return true;
  const sets: Record<string, string[]> = {
    FLEX: ['RB', 'WR', 'TE'],
    REC_FLEX: ['WR', 'TE'],
    WRRB_FLEX: ['WR', 'RB'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
    IDP_FLEX: ['DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S'],
    DL: ['DL', 'DE', 'DT'],
    DB: ['DB', 'CB', 'S', 'FS', 'SS']
  };
  return (sets[target] || []).some(position => normalized.includes(position));
}

interface State { score: number; assignments: Array<number | null>; filled: number }

/**
 * Exact maximum-value assignment. The objective per player is `expectedPoints` (published projection × documented play
 * probability) when set, otherwise the published projection. `correlationBonus` is a bounded tiebreaker (< decision band).
 */
export function optimizeLineup(players: PlayerEvaluation[], rosterPositions: string[], currentStarters: string[] = [], correlationBonus?: Map<string, number>): LineupEntry[] {
  const slots = starterSlots(rosterPositions);
  if (!slots.length) return [];
  if (slots.length > 20) throw new Error(`Unsupported starter slot count: ${slots.length}`);
  if (players.every(player => player.weeklyPoints == null)) {
    return slots.map((slot, index) => {
      const currentId = currentStarters[index] || null;
      const player = currentId ? players.find(item => item.playerId === currentId) || null : null;
      return { slot, player, previousPlayerId: currentId, changed: false };
    });
  }
  const size = 1 << slots.length;
  let states: Array<State | undefined> = new Array(size);
  const lockedAssignments: Array<number | null> = Array(slots.length).fill(null);
  let lockedMask = 0;
  let lockedCount = 0;
  const lockedPlayers = new Set<number>();
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const currentId = currentStarters[slotIndex];
    const playerIndex = players.findIndex(player => player.playerId === currentId && player.weeklyPoints == null && player.eligible && eligibleForSlot(player.positions, slots[slotIndex]));
    if (playerIndex < 0) continue;
    lockedAssignments[slotIndex] = playerIndex;
    lockedPlayers.add(playerIndex);
    lockedMask |= 1 << slotIndex;
    lockedCount++;
  }
  states[lockedMask] = { score: 0, assignments: lockedAssignments, filled: lockedCount };
  for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
    if (!players[playerIndex].eligible || lockedPlayers.has(playerIndex)) continue;
    const next = states.slice();
    for (let mask = 0; mask < size; mask++) {
      const state = states[mask];
      if (!state) continue;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
        if (mask & (1 << slotIndex) || !eligibleForSlot(players[playerIndex].positions, slots[slotIndex])) continue;
        const nextMask = mask | (1 << slotIndex);
        const continuity = currentStarters[slotIndex] === players[playerIndex].playerId ? 0.0001 : 0;
        const bonus = correlationBonus?.get(players[playerIndex].playerId) ?? 0;
        const score = state.score + (players[playerIndex].expectedPoints ?? players[playerIndex].weeklyPoints ?? 0) + continuity + bonus;
        const candidate: State = { score, filled: state.filled + 1, assignments: state.assignments.slice() };
        candidate.assignments[slotIndex] = playerIndex;
        const existing = next[nextMask];
        if (!existing || candidate.filled > existing.filled || (candidate.filled === existing.filled && candidate.score > existing.score)) next[nextMask] = candidate;
      }
    }
    states = next;
  }
  const full = states[size - 1];
  const best = full || states.filter(Boolean).sort((a, b) => b!.filled - a!.filled || b!.score - a!.score)[0]!;
  return slots.map((slot, index) => {
    const playerIndex = best.assignments[index];
    const player = playerIndex == null ? null : players[playerIndex];
    return { slot, player, previousPlayerId: currentStarters[index] || null, changed: Boolean(player && currentStarters[index] && player.playerId !== currentStarters[index]) };
  });
}

/**
 * Best lineup if every rostered player plays: published projections only, availability ignored. Players without a published
 * projection are left out (and never locked in as unknown current starters), so the result is a comparable projection total.
 */
export function optimizeIfEveryonePlays(players: PlayerEvaluation[], rosterPositions: string[], currentStarters: string[] = []): LineupEntry[] {
  const projected = players.filter(player => player.weeklyPoints != null && (player.eligible || player.availability?.riskFlag === 'EXCLUDED'));
  return optimizeLineup(projected.map(player => ({ ...player, expectedPoints: player.weeklyPoints, eligible: true })), rosterPositions, currentStarters);
}

/** Sum of published projections. Null if any starter lacks one (never a partial sum). */
export function lineupTotal(lineup: LineupEntry[]): number | null {
  if (!lineup.length || lineup.some(entry => !entry.player || entry.player.weeklyPoints == null)) return null;
  return Math.round(lineup.reduce((sum, entry) => sum + entry.player!.weeklyPoints!, 0) * 100) / 100;
}

/** Sum of availability-weighted expected points (projection × play probability). Null if any starter lacks a projection. */
export function lineupExpectedTotal(lineup: LineupEntry[]): number | null {
  if (!lineup.length || lineup.some(entry => !entry.player || entry.player.weeklyPoints == null)) return null;
  return Math.round(lineup.reduce((sum, entry) => sum + (entry.player!.expectedPoints ?? entry.player!.weeklyPoints!), 0) * 100) / 100;
}

function directPosition(position: string): string {
  if (position === 'DST') return 'DEF';
  if (['DE', 'DT'].includes(position)) return 'DL';
  if (['CB', 'S', 'FS', 'SS'].includes(position)) return 'DB';
  return position;
}

function demandForPosition(position: string, rosterPositions: string[]): number {
  const target = directPosition(position);
  let demand = rosterPositions.filter(slot => directPosition(slot) === target).length;
  for (const slot of rosterPositions) {
    if (slot === 'FLEX' && ['RB', 'WR', 'TE'].includes(target)) demand += 1 / 3;
    if (slot === 'REC_FLEX' && ['WR', 'TE'].includes(target)) demand += 1 / 2;
    if (slot === 'WRRB_FLEX' && ['WR', 'RB'].includes(target)) demand += 1 / 2;
    if (slot === 'SUPER_FLEX' && ['QB', 'RB', 'WR', 'TE'].includes(target)) demand += 1 / 4;
    if (slot === 'IDP_FLEX' && ['DL', 'LB', 'DB'].includes(target)) demand += 1 / 3;
  }
  return Math.max(1, Math.ceil(demand));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function calculateReplacementLevels(freeAgents: PlayerEvaluation[], rosterPositions: string[]): Record<string, ReplacementLevel> {
  const positions = [...new Set(freeAgents.flatMap(player => player.positions.map(directPosition)))];
  const levels: Record<string, ReplacementLevel> = {};
  for (const position of positions) {
    const players = freeAgents.filter(player => player.positions.map(directPosition).includes(position) && player.weeklyPoints != null).sort((a, b) => b.weeklyPoints! - a.weeklyPoints!);
    const demand = demandForPosition(position, rosterPositions);
    const topPool = players.slice(0, demand);
    const replacement = median(topPool.map(player => player.weeklyPoints!));
    const rosReplacement = median(topPool.map(player => player.restOfSeasonValue).filter((value): value is number => value != null));
    levels[position] = {
      position,
      bestAvailable: players[0]?.weeklyPoints ?? null,
      medianAvailable: median(players.map(player => player.weeklyPoints!)),
      replacementLevel: replacement == null ? null : Math.round(replacement * 100) / 100,
      rosReplacementLevel: rosReplacement == null ? null : Math.round(rosReplacement * 100) / 100,
      starterDemandPerTeam: demand,
      dropOffCurve: players.slice(0, 10).map(player => player.weeklyPoints!)
    };
  }
  return levels;
}

export function applyReplacementValues(players: PlayerEvaluation[], levels: Record<string, ReplacementLevel>): void {
  for (const player of players) {
    const position = directPosition(player.positions[0] || '');
    const level = levels[position];
    player.valueOverReplacement = player.weeklyPoints != null && level?.replacementLevel != null ? Math.round((player.weeklyPoints - level.replacementLevel) * 100) / 100 : null;
    player.scarcityValue = level?.bestAvailable != null && level.replacementLevel != null ? Math.round((level.bestAvailable - level.replacementLevel) * 100) / 100 : null;
  }
}

function topCandidates(freeAgents: PlayerEvaluation[], remainingWeeks: number): PlayerEvaluation[] {
  const groups = new Map<string, PlayerEvaluation[]>();
  for (const player of freeAgents) {
    if (player.weeklyPoints == null || !player.eligible || ['Out', 'Inactive', 'IR'].includes(player.injuryStatus || '')) continue;
    const position = player.positions[0] || 'OTHER';
    groups.set(position, [...(groups.get(position) || []), player]);
  }
  return [...groups.values()].flatMap(group => group.sort((a, b) => {
    const aRos = (a.restOfSeasonValue ?? 0) / remainingWeeks;
    const bRos = (b.restOfSeasonValue ?? 0) / remainingWeeks;
    return ((b.weeklyPoints ?? 0) + bRos + (b.valueOverReplacement ?? 0)) - ((a.weeklyPoints ?? 0) + aRos + (a.valueOverReplacement ?? 0));
  }).slice(0, 10));
}

export function decisionBand(replacementLevels: Record<string, ReplacementLevel> | undefined): number {
  const dispersion = median(Object.values(replacementLevels || {}).map(level => level.bestAvailable != null && level.replacementLevel != null ? Math.max(0, level.bestAvailable - level.replacementLevel) : 0).filter(value => value > 0)) ?? 1;
  return Math.max(1, Math.round(dispersion * 100) / 100);
}

export interface SearchOptions { week?: number; replacementLevels?: Record<string, ReplacementLevel>; waiverRules?: WaiverRules | null }

export interface TransactionSearchResult { lineup: LineupEntry[]; transactions: TransactionRecommendation[]; considered: TransactionRecommendation[]; summary: TransactionSummary }

/** Like `lineupExpectedTotal`, but an unfillable slot counts as 0 so a hole created by an injury can be priced against a fill-in. */
function searchTotal(lineup: LineupEntry[]): number | null {
  if (!lineup.length || lineup.some(entry => entry.player && entry.player.weeklyPoints == null)) return null;
  return Math.round(lineup.reduce((sum, entry) => sum + (entry.player ? entry.player.expectedPoints ?? entry.player.weeklyPoints! : 0), 0) * 100) / 100;
}

export const NO_CLAIM_HEADLINE = 'No waiver claim recommended.';

export function searchTransactions(roster: PlayerEvaluation[], freeAgents: PlayerEvaluation[], rosterPositions: string[], currentStarters: string[], options: SearchOptions = {}): TransactionSearchResult {
  const rules = options.waiverRules ?? null;
  const baseline = optimizeLineup(roster, rosterPositions, currentStarters);
  const baselineTotal = searchTotal(baseline);
  const holdSummary = (bestConsidered: TransactionSummary['bestConsidered'], why: string): TransactionSummary => ({ decision: 'HOLD', headline: NO_CLAIM_HEADLINE, waiverRules: rules, bestConsidered, why });
  if (baselineTotal == null) return { lineup: baseline, transactions: [], considered: [], summary: holdSummary(null, 'The current roster could not be scored, so no transaction can be evaluated.') };
  const remainingWeeks = Math.max(1, 18 - (options.week || 1) + 1);
  const starting = new Set(baseline.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const adds = topCandidates(freeAgents, remainingWeeks);
  const drops = roster.filter(player => !starting.has(player.playerId) && (player.weeklyPoints != null || player.restOfSeasonValue != null))
    .sort((a, b) => ((a.restOfSeasonValue ?? 0) / remainingWeeks + (a.valueOverReplacement ?? 0)) - ((b.restOfSeasonValue ?? 0) / remainingWeeks + (b.valueOverReplacement ?? 0))).slice(0, 14);
  type Swap = { add: PlayerEvaluation; drop: PlayerEvaluation };
  type Candidate = { lineup: LineupEntry[]; swaps: Swap[]; weeklyGain: number; assessment: TransactionAssessment; tier: RecommendationTier; confidence: 'High' | 'Medium' | 'Low' };
  const candidates: Candidate[] = [];

  const evaluate = (swaps: Swap[]) => {
    const dropIds = new Set(swaps.map(swap => swap.drop.playerId));
    const candidateRoster = [...roster.filter(player => !dropIds.has(player.playerId)), ...swaps.map(swap => swap.add)];
    const lineup = optimizeLineup(candidateRoster, rosterPositions, currentStarters);
    const total = searchTotal(lineup);
    if (total == null) return;
    const weeklyGain = Math.round((total - baselineTotal) * 100) / 100;
    const { assessment, tier, confidence } = assessTransaction({
      swaps: swaps.map(swap => ({ ...swap, acquisition: swap.add.acquisition })), weeklyGain, baselineLineup: baseline, roster, remainingWeeks, rules, eligibleForSlot
    });
    candidates.push({ lineup, swaps, weeklyGain, assessment, tier, confidence });
  };

  for (const add of adds) for (const drop of drops) evaluate([{ add, drop }]);
  const pairAdds = adds.slice(0, 6);
  const pairDrops = drops.slice(0, 6);
  for (let a = 0; a < pairAdds.length; a++) for (let b = a + 1; b < pairAdds.length; b++) {
    for (let d = 0; d < pairDrops.length; d++) for (let e = d + 1; e < pairDrops.length; e++) evaluate([{ add: pairAdds[a], drop: pairDrops[d] }, { add: pairAdds[b], drop: pairDrops[e] }]);
  }

  candidates.sort((a, b) => b.assessment.net - a.assessment.net || b.weeklyGain - a.weeklyGain);
  const toRecommendation = (candidate: Candidate, swap: Swap, recommended: boolean): TransactionRecommendation => {
    const restOfSeasonGain = swap.add.restOfSeasonValue != null && swap.drop.restOfSeasonValue != null ? Math.round((swap.add.restOfSeasonValue - swap.drop.restOfSeasonValue) * 100) / 100 : null;
    const a = candidate.assessment;
    return {
      add: swap.add, drop: swap.drop, weeklyGain: candidate.weeklyGain, restOfSeasonGain, confidence: candidate.confidence, tier: candidate.tier,
      acquisition: a.waiver.acquisition, assessment: a, score: a.net, recommended, resultingLineup: candidate.lineup,
      components: {
        weeklyLineupGain: candidate.weeklyGain, rosPerWeekGain: a.longTerm.rosGainPerWeek, replacementAdjustedGain: swap.add.valueOverReplacement ?? null,
        dropOpportunityCost: a.drop.cost, injuryRiskPenalty: Math.round(Math.max(0, (swap.add.weeklyPoints || 0) - (swap.add.expectedPoints ?? swap.add.weeklyPoints ?? 0)) * 100) / 100
      },
      reasons: a.sections.map(section => `${section.label}: ${section.text}`)
    };
  };
  const actionable = (candidate: Candidate) => candidate.tier === 'STRONG CLAIM' || candidate.tier === 'CLAIM';
  const bestSingle = candidates.find(candidate => candidate.swaps.length === 1 && actionable(candidate));
  const bestPair = candidates.find(candidate => candidate.swaps.length > 1 && actionable(candidate));
  // A second claim must earn its own priority cost: the pair has to beat the best single move by a full claim threshold.
  const best = bestPair && (!bestSingle || bestPair.assessment.net >= bestSingle.assessment.net + bestPair.assessment.required.claim) ? bestPair : bestSingle;
  const transactions = best ? best.swaps.map(swap => toRecommendation(best, swap, true)) : [];
  const selectedAdds = new Set(best?.swaps.map(swap => swap.add.playerId) || []);
  const seen = new Set<string>();
  const considered = candidates.filter(candidate => {
    if (candidate.swaps.length !== 1 || selectedAdds.has(candidate.swaps[0].add.playerId) || seen.has(candidate.swaps[0].add.playerId)) return false;
    seen.add(candidate.swaps[0].add.playerId);
    return true;
  }).slice(0, 8).map(candidate => toRecommendation(candidate, candidate.swaps[0], false));
  const top = best ? null : considered[0] ?? null;
  const bestConsidered = top ? { add: top.add.name, drop: top.drop.name, tier: top.tier as RecommendationTier, net: top.assessment?.net ?? 0, weeklyGain: top.weeklyGain } : null;
  const summary: TransactionSummary = best
    ? { decision: 'MOVE', headline: `${best.swaps.map(swap => `${swap.add.name} for ${swap.drop.name}`).join(' and ')}: ${best.tier}.`, waiverRules: rules, bestConsidered: null, why: 'The best transaction cleared the claim threshold after weekly gain, long-term evidence, drop cost and waiver cost.' }
    : holdSummary(bestConsidered, top
      ? `The best alternative (${top.add.name} for ${top.drop.name}, ${top.weeklyGain != null ? `${top.weeklyGain >= 0 ? '+' : '−'}${Math.abs(top.weeklyGain).toFixed(1)}` : 'n/a'} weekly) scored ${top.tier} with net ${(top.assessment?.net ?? 0).toFixed(1)} against +${(top.assessment?.required.claim ?? 0).toFixed(1)} required. Holding is the highest-value option.`
      : 'No free agent produced a scoreable alternative to the current roster. Holding is the highest-value option.');
  return { lineup: best?.lineup || baseline, transactions, considered, summary };
}
