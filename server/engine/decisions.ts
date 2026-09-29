import type { LineupDecision, LineupDecisionKind, LineupEntry, PlayerEvaluation } from '../../shared/types.js';
import { eligibleForSlot } from './optimizer.js';

/** Projection gaps at or below this (points) are within projection noise and reported as a toss-up. */
export const TOSS_UP_POINTS = 0.1;

const f = (value: number | null | undefined) => value == null ? 'n/a' : value.toFixed(1);
const signed = (value: number) => `${value >= 0 ? '+' : ''}${value !== 0 && Math.abs(value) < 0.1 ? value.toFixed(2) : value.toFixed(1)}`;

function kickoffText(player: PlayerEvaluation): string {
  if (!player.gameTime) return 'kickoff time unavailable';
  return `${player.team || 'his team'} vs ${player.opponent || 'opponent'}, kickoff ${new Date(player.gameTime).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })}`;
}

function classify(start: PlayerEvaluation, bench: PlayerEvaluation, band: number): { kind: LineupDecisionKind; difference: number | null } {
  const difference = start.weeklyPoints != null && bench.weeklyPoints != null ? Math.round((start.weeklyPoints - bench.weeklyPoints) * 100) / 100 : null;
  if (bench.weeklyPoints == null || start.weeklyPoints == null) return { kind: 'NO_PROJECTION', difference };
  const benchP = bench.availability?.playProbability ?? 1;
  if (difference! < -TOSS_UP_POINTS && benchP < 1) return { kind: benchP === 0 ? 'AVAILABILITY_EXCLUSION' : 'AVAILABILITY_DISCOUNT', difference };
  if (Math.abs(difference!) <= TOSS_UP_POINTS) return { kind: 'TOSS_UP', difference };
  if (difference! > 0 && difference! < band) return { kind: 'CLOSE_CALL', difference };
  return { kind: 'PROJECTION', difference };
}

export function buildDecision(start: PlayerEvaluation, bench: PlayerEvaluation, band: number, correlationTiebreak: boolean): LineupDecision {
  const { kind, difference } = classify(start, bench, band);
  const a = bench.availability;
  const startExpected = start.expectedPoints ?? start.weeklyPoints;
  const benchExpected = bench.expectedPoints ?? bench.weeklyPoints;
  const sacrifice = (kind === 'AVAILABILITY_EXCLUSION' || kind === 'AVAILABILITY_DISCOUNT') && difference != null ? Math.round(-difference * 100) / 100 : null;
  const logic: string[] = [];
  const change: string[] = [];
  let headline: string;
  let whyLower: string | null = null;

  const projectionLine = `Published projections (unchanged): ${start.name} ${f(start.weeklyPoints)}, ${bench.name} ${f(bench.weeklyPoints)}${difference == null ? '' : ` — difference ${signed(difference)} for ${start.name}`}.`;

  if (kind === 'AVAILABILITY_EXCLUSION' || kind === 'AVAILABILITY_DISCOUNT') {
    const status = a?.status || 'a concern';
    const exclusion = kind === 'AVAILABILITY_EXCLUSION';
    headline = exclusion
      ? `AVAILABILITY OVERRIDE: start ${start.name} over ${bench.name} — ${bench.name} is ${status}, so he cannot be started. This accepts ${f(sacrifice)} fewer projected points than a healthy ${bench.name}.`
      : `AVAILABILITY OVERRIDE: start ${start.name} over ${bench.name} — ${bench.name}'s availability (${status}, ${Math.round((a?.playProbability ?? 0) * 100)}% play estimate) outweighs a ${f(sacrifice)}-point projection edge.`;
    whyLower = `${bench.name} has the higher published projection (${f(bench.weeklyPoints)} vs ${f(start.weeklyPoints)}), but his availability is a concern: ${status}${a?.injury ? ` (${a.injury})` : ''}. ${start.name} does NOT project higher — this is a risk decision, not a projection decision.`;
    logic.push(projectionLine);
    logic.push(`Availability policy: ${a?.policy}. Expected points = projection × chance of playing: ${bench.name} ${f(bench.weeklyPoints)} × ${(a?.playProbability ?? 0).toFixed(2)} = ${f(benchExpected)}; ${start.name} ${f(start.weeklyPoints)} × ${(start.availability?.playProbability ?? 1).toFixed(2)} = ${f(startExpected)}.`);
    logic.push(exclusion
      ? `${bench.name} is excluded outright while designated ${status}: a player who does not play scores 0, so the solver never considers him. ${start.name} is the best eligible option for this slot.`
      : `The solver maximizes expected points, and ${start.name}'s ${f(startExpected)} beats ${bench.name}'s risk-weighted ${f(benchExpected)}. If ${bench.name} plays normally the lineup gives up ${f(sacrifice)} points; if he does not, it gains ${f(startExpected)}.`);
    logic.push(`The projection sacrifice is accepted because ${exclusion ? 'a designated-out player has no chance to score' : 'the expected loss from a likely non-participant is larger than the projection gap'}; no published projection was edited.`);
    if (a?.gameStarted) logic.push(`Timing note: ${bench.name}'s game for this scoring week has already started or finished (${kickoffText(bench)}). Sleeper locks that slot, so a designation issued after the game mainly matters for his next game rather than this week's lineup.`);
    if (a && bench.weeklyPoints != null && startExpected != null && bench.weeklyPoints > 0) {
      const breakEven = Math.min(1, startExpected / bench.weeklyPoints);
      change.push(`Break-even: ${bench.name} becomes the better start once his chance of playing exceeds about ${Math.round(breakEven * 100)}% (${f(startExpected)} ÷ ${f(bench.weeklyPoints)}).`);
    }
    change.push(`If ${bench.name} is upgraded to Questionable or Active, or practices fully or in a limited capacity, re-run Optimize: with no availability concern he projects ${f(bench.weeklyPoints)}, ${f(sacrifice)} above ${start.name}, and becomes the preferred start.`);
    change.push(`If ${bench.name} is confirmed out (or placed on IR), ${start.name} remains the start and this recommendation holds.`);
  } else if (kind === 'NO_PROJECTION') {
    headline = `Start ${start.name} over ${bench.name}: ${bench.weeklyPoints == null ? `${bench.name} has no published projection this week` : `${start.name} has no published projection this week`}.`;
    logic.push(projectionLine);
    if (bench.weeklyPoints == null) logic.push(`No source published a projection for ${bench.name}, so no points were inferred for him; ${start.name} (${f(start.weeklyPoints)}) is the best eligible player with a projection.`);
    if (a && a.status !== 'ACTIVE') logic.push(`${bench.name} is also designated ${a.status}${a.injury ? ` (${a.injury})` : ''}.`);
    if (a?.gameStarted) logic.push(`Timing note: ${bench.name}'s game has already started or finished (${kickoffText(bench)}).`);
    change.push(`If a source publishes a projection for ${bench.name} (or his designation changes), re-run Optimize.`);
  } else {
    const gapText = difference == null ? '' : `${signed(difference)} projected points`;
    const reshuffle = kind === 'PROJECTION' && (difference ?? 0) < 0;
    headline = reshuffle
      ? `Lineup reshuffle: ${start.name} takes a slot from ${bench.name} in the best overall assignment (${gapText} for this pair alone; the full lineup's expected points still go up).`
      : kind === 'TOSS_UP'
      ? `Toss-up: ${start.name} and ${bench.name} are effectively tied (${gapText}) — either is a fine start.`
      : kind === 'CLOSE_CALL'
        ? `Close call: start ${start.name} over ${bench.name} (${gapText}, inside the ${f(band)}-point decision band).`
        : `Start ${start.name} over ${bench.name}: ${gapText}, a clear projection-based upgrade.`;
    logic.push(projectionLine);
    logic.push(reshuffle
      ? `This pair is part of a multi-slot reshuffle: the solver maximized the whole lineup's expected points, not this pair in isolation.`
      : `Both players are healthy enough to take the normal projection-first path; the higher expected-points player was chosen.`);
    if (kind === 'TOSS_UP') logic.push(`A gap of ${gapText} is far inside projection noise. Keeping ${bench.name} would be equally reasonable.`);
    if (correlationTiebreak) logic.push(`Correlation tiebreak applied: a QB/pass-catcher relationship with your opponent's lineup was used because the projections were within the decision band. It cannot outweigh a real projection gap.`);
    if (bench.availability && bench.availability.riskFlag !== 'NONE') logic.push(`${bench.name}'s availability (${bench.availability.status}) was noted but did not decide this pair.`);
    change.push(`This changes if either player's published projection or availability changes; re-run Optimize after the next injury report or projection update.`);
  }
  return {
    kind, headline, startId: start.playerId, startName: start.name, benchId: bench.playerId, benchName: bench.name,
    startProjection: start.weeklyPoints, benchProjection: bench.weeklyPoints, difference, projectionSacrifice: sacrifice,
    startExpected: startExpected ?? null, benchExpected: benchExpected ?? null, benchAvailability: a || null,
    whyLowerProjection: whyLower, decisionLogic: logic, whatCouldChange: change, correlationTiebreak
  };
}

/**
 * Marks which recommended starters are genuinely new (not starting today, in any slot) and attaches a structured decision
 * pairing each with the current starter it displaces. Slot-order shuffles of players already starting are not "changes".
 */
export function attachLineupDecisions(current: LineupEntry[], recommended: LineupEntry[], band: number, tiebrokenIds: Set<string>): void {
  const recommendedIds = new Set(recommended.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const currentIds = new Set(current.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const displaced = current.flatMap((entry, index) => entry.player && !recommendedIds.has(entry.player.playerId) ? [{ index, player: entry.player }] : []);
  const used = new Set<number>();
  recommended.forEach((entry, index) => {
    entry.changed = false;
    delete entry.decision;
    const player = entry.player;
    if (!player || currentIds.has(player.playerId)) return;
    entry.changed = true;
    let pair = displaced.find(item => item.index === index && !used.has(item.index));
    if (!pair) pair = displaced.find(item => !used.has(item.index) && item.player.positions.some(position => player.positions.includes(position)));
    if (!pair) pair = displaced.find(item => !used.has(item.index) && eligibleForSlot(item.player.positions, entry.slot));
    if (!pair) pair = displaced.find(item => !used.has(item.index));
    if (!pair) return;
    used.add(pair.index);
    entry.previousPlayerId = pair.player.playerId;
    entry.decision = buildDecision(player, pair.player, band, tiebrokenIds.has(player.playerId));
  });
}
