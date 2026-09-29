import type {
  Acquisition, AcquisitionKind, LineupEntry, PlayerEvaluation, RecommendationTier, RoleKind, TransactionAssessment, TransactionSection, WaiverRules
} from '../../shared/types.js';
import type { GameRow } from '../providers/nflverse.js';
import { normalizeTeam } from '../services/player-mapping.js';
import { kickoffMs } from './target-week.js';
import { ROLE_PERSISTENCE } from './role.js';

/**
 * Every number in the waiver model. Units are league-scored expected points for one week. See ARCHITECTURE.md ("Waiver and
 * add/drop decisions"). None of these values is a projection; they are the price of moving away from HOLD.
 */
export const WAIVER_MODEL = {
  claimCostBase: 3,
  priorityFloor: 0.6,
  optional: 1.5,
  claim: 3,
  strong: 6,
  insufficientEvidenceClaim: 1,
  insufficientEvidenceStrong: 2,
  lowConfidence: 0.5,
  roleThresholdShift: { DURABLE: -0.5, MODERATE: 0, TEMPORARY_FILL_IN: 1, LIMITED: 0.5, UNKNOWN: 0.5 } as Record<RoleKind, number>,
  proximityMax: 2,
  proximityWindow: 3,
  durableDropRole: 1,
  moderateDropRole: 0.5,
  depthLossPerSlot: 1.5,
  needCreditPerSlot: 2,
  rosHorizonWeeks: 4,
  rosDiscount: 0.5,
  avoidBelow: -2,
  speculativeMaxDropCost: 0.5
};

const SLOT_DEPTH_TARGET: Record<string, number> = { QB: 1, RB: 3, WR: 3, TE: 1, K: 1, DEF: 1 };

export function inferWaiverRules(input: {
  leagueSettings: Record<string, number> | undefined; rosterSettings: Record<string, number> | undefined; teams: number; transactionsLoaded: boolean;
}): WaiverRules {
  const settings = input.leagueSettings || {};
  const type: WaiverRules['type'] = settings.waiver_type === 0 ? 'ROLLING' : settings.waiver_type === 1 ? 'REVERSE_STANDINGS' : settings.waiver_type === 2 ? 'FAAB' : 'UNKNOWN';
  const position = input.rosterSettings?.waiver_position;
  const notes = [
    'Sleeper does not expose a per-player "requires a waiver claim" flag. Acquisition type is inferred from (a) drops within the league\'s waiver-clear window and (b) whether the player\'s NFL game this Sleeper week has already kicked off (Sleeper holds those players until the weekly waiver run).',
    ...(type === 'FAAB' ? ['FAAB leagues bid a budget rather than spend priority; the same conservative cost is applied as a stand-in.'] : []),
    ...(type === 'UNKNOWN' ? ['The waiver type is not reported, so claims are treated as costing priority.'] : []),
    ...(input.transactionsLoaded ? [] : ['Recent league transactions could not be loaded, so a player without a visible drop is treated as UNKNOWN (priced like a claim).'])
  ];
  return { type, clearDays: Number.isFinite(settings.waiver_clear_days) ? settings.waiver_clear_days : null, priorityPosition: position != null && Number.isFinite(position) ? position : null, teams: input.teams, transactionsLoaded: input.transactionsLoaded, notes };
}

export interface AcquisitionInput {
  team: string | null;
  playerId: string;
  now: Date;
  sleeperWeek: number;
  season: string;
  games: GameRow[];
  recentDrops: Map<string, number>;
  clearDays: number | null;
  transactionsLoaded: boolean;
}

export function recentDropsFromTransactions(raw: unknown[]): Map<string, number> {
  const drops = new Map<string, number>();
  for (const item of raw) {
    const txn = item as { status?: string; drops?: Record<string, number> | null; status_updated?: number; created?: number };
    if (txn?.status !== 'complete' || !txn.drops) continue;
    const at = txn.status_updated ?? txn.created;
    if (typeof at !== 'number') continue;
    for (const id of Object.keys(txn.drops)) if (at > (drops.get(id) ?? 0)) drops.set(id, at);
  }
  return drops;
}

export function inferAcquisition(input: AcquisitionInput): Acquisition {
  const now = input.now.getTime();
  const droppedAt = input.recentDrops.get(input.playerId);
  const clearMs = (input.clearDays ?? 2) * 86_400_000;
  if (droppedAt != null && now - droppedAt < clearMs) {
    return { kind: 'WAIVER_CLAIM', reason: `Dropped by a league team on ${new Date(droppedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC, inside the ${input.clearDays ?? 2}-day waiver window.`, clearsAt: new Date(droppedAt + clearMs).toISOString() };
  }
  const team = normalizeTeam(input.team);
  const game = team ? input.games.find(item => String(item.season) === input.season && Number(item.week) === input.sleeperWeek && (normalizeTeam(item.home_team) === team || normalizeTeam(item.away_team) === team)) : undefined;
  const kickoff = game ? kickoffMs(game) : null;
  if (game && kickoff != null && kickoff <= now) {
    return { kind: 'WAIVER_CLAIM', reason: `${input.team}'s Week ${input.sleeperWeek} game has already kicked off, so Sleeper treats the player as waiver-only until the weekly waiver run.` };
  }
  if (!input.transactionsLoaded) return { kind: 'UNKNOWN', reason: 'Recent league transactions were unavailable, so waiver status could not be checked.' };
  return { kind: 'FREE_AGENT', reason: 'No recent drop and the team has not played this Sleeper week; an instant add appears available (inferred, not reported by Sleeper).' };
}

export function priorityFactor(rules: WaiverRules | null): number {
  if (!rules || rules.priorityPosition == null || rules.teams < 2) return 1;
  const share = 1 - (rules.priorityPosition - 1) / (rules.teams - 1);
  return WAIVER_MODEL.priorityFloor + (1 - WAIVER_MODEL.priorityFloor) * Math.min(1, Math.max(0, share));
}

export function waiverCost(kind: AcquisitionKind, rules: WaiverRules | null): number {
  return kind === 'FREE_AGENT' ? 0 : round(WAIVER_MODEL.claimCostBase * priorityFactor(rules));
}

const round = (value: number) => Math.round(value * 100) / 100;
const points = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
const pts = (player: PlayerEvaluation) => player.expectedPoints ?? player.weeklyPoints ?? 0;

function availableThisWeek(player: PlayerEvaluation): boolean {
  if (player.rosterStatus === 'reserve' || player.rosterStatus === 'taxi') return false;
  if ((player.availability?.playProbability ?? 1) < 0.5) return false;
  return !(player.team && player.opponent == null);
}

function shortfall(players: PlayerEvaluation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const player of players) if (availableThisWeek(player)) counts.set(player.positions[0], (counts.get(player.positions[0]) || 0) + 1);
  const result = new Map<string, number>();
  for (const [position, target] of Object.entries(SLOT_DEPTH_TARGET)) result.set(position, Math.max(0, target - (counts.get(position) || 0)));
  return result;
}

export interface SwapInput { add: PlayerEvaluation; drop: PlayerEvaluation; acquisition: Acquisition | undefined }

export interface AssessInput {
  swaps: SwapInput[];
  weeklyGain: number;
  baselineLineup: LineupEntry[];
  roster: PlayerEvaluation[];
  remainingWeeks: number;
  rules: WaiverRules | null;
  eligibleForSlot: (positions: string[], slot: string) => boolean;
}

export function assessTransaction(input: AssessInput): { assessment: TransactionAssessment; tier: RecommendationTier; confidence: 'High' | 'Medium' | 'Low' } {
  const { swaps, weeklyGain, baselineLineup, roster, remainingWeeks, rules } = input;
  const adds = swaps.map(swap => swap.add);
  const drops = swaps.map(swap => swap.drop);
  const names = (list: PlayerEvaluation[]) => list.map(player => player.name).join(' + ');

  const mappingReliable = swaps.every(({ add, drop }) => ['exact', 'high'].includes(add.mappingConfidence || '') && ['exact', 'high'].includes(drop.mappingConfidence || ''));
  const coverage = Math.min(...swaps.map(({ add, drop }) => Math.min(add.projectionCoverage ?? 0, drop.projectionCoverage ?? 0))) / 100;
  const confidenceFactor = round(0.75 + 0.25 * Math.min(1, Math.max(0, coverage)) * (mappingReliable ? 1 : 0.9));

  const rosKnown = swaps.every(({ add, drop }) => add.restOfSeasonValue != null && drop.restOfSeasonValue != null);
  const rosGainPerWeek = rosKnown ? round(swaps.reduce((sum, { add, drop }) => sum + ((add.restOfSeasonValue as number) - (drop.restOfSeasonValue as number)) / remainingWeeks, 0)) : null;
  const longTermCredit = rosGainPerWeek == null ? null : round(rosGainPerWeek * Math.min(remainingWeeks, WAIVER_MODEL.rosHorizonWeeks) * WAIVER_MODEL.rosDiscount);

  const addRoles = adds.map(player => player.role?.kind ?? 'UNKNOWN');
  const weakestRole = (['TEMPORARY_FILL_IN', 'LIMITED', 'UNKNOWN', 'MODERATE', 'DURABLE'] as RoleKind[]).find(kind => addRoles.includes(kind)) as RoleKind;
  const persistenceFactor = rosKnown ? 1 : Math.min(...addRoles.map(kind => ROLE_PERSISTENCE[kind]));
  const adjustedGain = round(weeklyGain > 0 ? weeklyGain * confidenceFactor * persistenceFactor : weeklyGain);

  const dropNotes: string[] = [];
  let startingCaliberValue = 0;
  let roleValue = 0;
  for (const drop of drops) {
    const starters = baselineLineup.filter(entry => entry.player && input.eligibleForSlot(drop.positions, entry.slot)).map(entry => pts(entry.player as PlayerEvaluation));
    const gap = starters.length ? Math.min(...starters) - pts(drop) : Infinity;
    const proximity = round(WAIVER_MODEL.proximityMax * Math.min(1, Math.max(0, (WAIVER_MODEL.proximityWindow - gap) / WAIVER_MODEL.proximityWindow)));
    const role = drop.role?.kind ?? 'UNKNOWN';
    const value = role === 'DURABLE' ? WAIVER_MODEL.durableDropRole : role === 'MODERATE' ? WAIVER_MODEL.moderateDropRole : 0;
    startingCaliberValue += proximity;
    roleValue += value;
    dropNotes.push(`${drop.name}: ${Number.isFinite(gap) ? (gap <= 0 ? 'projects at or above your weakest eligible starter' : `projects ${gap.toFixed(1)} pts below your weakest eligible starter`) : 'no eligible starter slot to compare against'} (${points(proximity).replace('+', '')} pts starting-caliber value); ${drop.role ? drop.role.summary : 'role evidence unavailable'}${value ? ` (${value.toFixed(1)} pts role value).` : ''}`);
  }
  const before = shortfall(roster);
  const dropIds = new Set(drops.map(player => player.playerId));
  const after = shortfall([...roster.filter(player => !dropIds.has(player.playerId)), ...adds]);
  let depthLossSlots = 0;
  let needSlots = 0;
  const needNotes: string[] = [];
  for (const position of Object.keys(SLOT_DEPTH_TARGET)) {
    const delta = (after.get(position) || 0) - (before.get(position) || 0);
    if (delta > 0) { depthLossSlots += delta; dropNotes.push(`Leaves ${position} depth ${delta} player${delta === 1 ? '' : 's'} short of a starter-plus-backup cushion (injury/bye insurance).`); }
    if (delta < 0) { needSlots += -delta; needNotes.push(`Fills a ${position} depth shortfall (injured, on bye or missing players at the position).`); }
  }
  const depthLoss = round(depthLossSlots * WAIVER_MODEL.depthLossPerSlot);
  const needCredit = round(Math.min(2, needSlots) * WAIVER_MODEL.needCreditPerSlot);
  const dropCost = round(startingCaliberValue + roleValue + depthLoss);

  const acquisitions = swaps.map(swap => swap.acquisition?.kind ?? 'UNKNOWN');
  const acquisition: AcquisitionKind = acquisitions.every(kind => kind === 'FREE_AGENT') ? 'FREE_AGENT' : acquisitions.includes('WAIVER_CLAIM') ? 'WAIVER_CLAIM' : 'UNKNOWN';
  const claimsCost = round(acquisitions.reduce((sum, kind) => sum + waiverCost(kind, rules), 0));
  const waiverNote = acquisition === 'FREE_AGENT'
    ? `No priority cost: ${names(adds)} appears to be an instant free-agent add (${swaps[0].acquisition?.reason}).`
    : `${acquisition === 'UNKNOWN' ? 'Waiver status could not be verified, so this is priced as a claim. ' : ''}A ${rules?.type === 'ROLLING' ? 'rolling-waiver ' : ''}claim spends waiver priority${rules?.priorityPosition != null ? ` (you are #${rules.priorityPosition} of ${rules.teams}; a successful claim sends you to the back)` : ''}. Priced at ${claimsCost.toFixed(1)} pts${swaps.length > 1 ? ' across both claims' : ''}. ${swaps.map(swap => swap.acquisition?.reason).filter(Boolean).join(' ')}`;

  const net = round(adjustedGain + (longTermCredit ?? 0) + needCredit - dropCost - claimsCost);

  const adjustments: string[] = [];
  let claim: number = WAIVER_MODEL.claim;
  let strong: number = WAIVER_MODEL.strong;
  let optional: number = WAIVER_MODEL.optional;
  if (!rosKnown) { claim += WAIVER_MODEL.insufficientEvidenceClaim; strong += WAIVER_MODEL.insufficientEvidenceStrong; adjustments.push(`+${WAIVER_MODEL.insufficientEvidenceClaim.toFixed(1)} to claim / +${WAIVER_MODEL.insufficientEvidenceStrong.toFixed(1)} to strong: no rest-of-season evidence`); }
  const shift = WAIVER_MODEL.roleThresholdShift[weakestRole];
  if (shift) { claim += shift; strong += shift; adjustments.push(`${shift > 0 ? '+' : '−'}${Math.abs(shift).toFixed(1)}: ${weakestRole.replace(/_/g, ' ').toLowerCase()} role for the add`); }

  const confidencePoints = (coverage >= 0.9 ? 1 : coverage >= 0.7 ? 0.5 : 0) + (mappingReliable ? 1 : 0) + (rosKnown ? 1 : 0) + (weakestRole !== 'UNKNOWN' ? 1 : 0) + (adds.every(player => (player.availability?.playProbability ?? 1) >= 1) ? 1 : 0);
  const confidence: 'High' | 'Medium' | 'Low' = confidencePoints >= 4 ? 'High' : confidencePoints >= 2.5 ? 'Medium' : 'Low';
  if (confidence === 'Low') { claim += WAIVER_MODEL.lowConfidence; strong += WAIVER_MODEL.lowConfidence; optional += WAIVER_MODEL.lowConfidence; adjustments.push(`+${WAIVER_MODEL.lowConfidence.toFixed(1)}: low confidence in the inputs`); }

  const addsUnavailable = adds.some(player => (player.availability?.playProbability ?? 1) < 0.5);
  const canBeStrong = rosKnown || (weakestRole !== 'TEMPORARY_FILL_IN' && weakestRole !== 'LIMITED');
  const lottery = weeklyGain >= 0 && dropCost <= WAIVER_MODEL.speculativeMaxDropCost && adds.some(player => (player.role?.injuriesAhead.length ?? 0) > 0);
  const tier: RecommendationTier = addsUnavailable || net <= WAIVER_MODEL.avoidBelow ? 'AVOID'
    : net >= strong && canBeStrong ? 'STRONG CLAIM' : net >= claim ? 'CLAIM' : net >= optional ? 'OPTIONAL' : lottery ? 'SPECULATIVE' : 'HOLD';

  const scale = confidenceFactor * persistenceFactor;
  const breakEven = round(Math.max(0, (claim - (longTermCredit ?? 0) - needCredit + dropCost + claimsCost) / (scale || 1)));

  const longTermText = rosGainPerWeek == null
    ? `Unavailable: no rest-of-season projection or ranking is available for these players, and none was invented. This is treated as insufficient long-term evidence (thresholds raised), not as zero value. Role evidence for ${names(adds)}: ${adds.map(player => player.role?.summary || 'no role data').join(' | ')}${persistenceFactor !== 1 ? ` Role-based persistence multiplier ×${persistenceFactor.toFixed(2)} applied to the weekly gain (context, not a projection).` : ''}`
    : `${points(rosGainPerWeek)} pts per remaining week (${points(longTermCredit as number)} counted over a ${Math.min(remainingWeeks, WAIVER_MODEL.rosHorizonWeeks)}-week horizon at ${WAIVER_MODEL.rosDiscount} weight).`;
  const sections: TransactionSection[] = [
    { label: 'WEEKLY IMPACT', text: `${points(weeklyGain)} projected points (availability-weighted, fully re-optimized lineup). Input-quality factor ${confidenceFactor.toFixed(2)}${persistenceFactor !== 1 && weeklyGain > 0 ? `, persistence ×${persistenceFactor.toFixed(2)}` : ''} → ${points(adjustedGain)} counted.` },
    { label: 'LONG-TERM VALUE', text: longTermText },
    { label: 'DROP COST', text: `${dropCost.toFixed(1)} pts. ${dropNotes.join(' ')}` },
    { label: 'WAIVER COST', text: `${claimsCost.toFixed(1)} pts. ${waiverNote}` },
    ...(needNotes.length ? [{ label: 'ROSTER NEED', text: `${needCredit.toFixed(1)} pts credit. ${needNotes.join(' ')}` }] : []),
    { label: 'CONFIDENCE', text: `${confidence}. ${adds.map(player => `${player.name}: ${player.newsItems.length ? `${player.newsItems.length} recent news item${player.newsItems.length === 1 ? '' : 's'} (latest: "${player.newsItems[0].headline}")` : 'no recent news found'}`).join('; ')}.` },
    { label: 'RECOMMENDATION', text: `${tier}. Net ${points(net)} pts (weekly ${points(adjustedGain)}${longTermCredit != null ? `, long-term ${points(longTermCredit)}` : ''}${needCredit ? `, need +${needCredit.toFixed(1)}` : ''}, drop −${dropCost.toFixed(1)}, waiver −${claimsCost.toFixed(1)}) versus +${claim.toFixed(1)} required for a claim${adjustments.length ? ` (${adjustments.join('; ')})` : ''}. The weekly gain would need to be about ${points(breakEven)} to clear it.` }
  ];
  sections.push({ label: 'WHY', text: explain(tier, { weeklyGain, dropCost, claimsCost, rosKnown, weakestRole, acquisition, need: needCredit, net, claim }) });

  return {
    tier, confidence,
    assessment: {
      weekly: { gain: weeklyGain, confidenceFactor, persistenceFactor, adjustedGain },
      longTerm: { status: rosKnown ? 'AVAILABLE' : 'INSUFFICIENT', rosGainPerWeek, credit: longTermCredit, note: longTermText },
      drop: { cost: dropCost, startingCaliberValue: round(startingCaliberValue), roleValue, depthLoss, notes: dropNotes },
      need: { credit: needCredit, notes: needNotes },
      waiver: { acquisition, cost: claimsCost, priorityPosition: rules?.priorityPosition ?? null, teams: rules?.teams ?? null, note: waiverNote },
      net, required: { optional: round(optional), claim: round(claim), strong: round(strong), adjustments }, breakEvenWeeklyGain: breakEven, sections
    }
  };
}

function explain(tier: RecommendationTier, f: { weeklyGain: number; dropCost: number; claimsCost: number; rosKnown: boolean; weakestRole: RoleKind; acquisition: AcquisitionKind; need: number; net: number; claim: number }): string {
  const uncertain = f.rosKnown ? '' : ', with long-term value unavailable';
  const cost = [f.dropCost > 0 ? `${f.dropCost.toFixed(1)} pts of drop cost` : '', f.claimsCost > 0 ? `${f.claimsCost.toFixed(1)} pts of waiver-priority cost` : ''].filter(Boolean).join(' and ');
  switch (tier) {
    case 'STRONG CLAIM': return `The gain is large enough to clear even the raised bar${f.need ? ' and it also fills a real depth need' : ''}${f.weakestRole === 'DURABLE' || f.weakestRole === 'MODERATE' ? ', with a role that looks likely to last' : ''}.`;
    case 'CLAIM': return `The gain outweighs ${cost || 'the transaction costs'} by enough to clear the claim threshold${uncertain}.`;
    case 'OPTIONAL': return `Positive but below the claim threshold: net ${points(f.net)} vs +${f.claim.toFixed(1)}${uncertain}. Reasonable only if you value this player beyond what the numbers show; preserving ${f.acquisition === 'FREE_AGENT' ? 'the roster spot' : 'waiver priority'} is the default.`;
    case 'AVOID': return `This move loses value after ${cost || 'costs'}, or the add is not expected to play. Do not make it.`;
    case 'SPECULATIVE': return `A lottery ticket, not a plan: the drop is nearly free, but the gain (${points(f.weeklyGain)}) is below the bar${uncertain}. Only worth it if a roster spot is otherwise idle${f.acquisition === 'FREE_AGENT' ? '' : ' and you are willing to spend waiver priority'}.`;
    default: return `The ${points(f.weeklyGain)} weekly gain does not clear ${cost || 'the threshold'}${uncertain}; with rolling waivers, preserving ${f.acquisition === 'FREE_AGENT' ? 'the roster spot' : 'priority and roster value'} is preferred.`;
  }
}
