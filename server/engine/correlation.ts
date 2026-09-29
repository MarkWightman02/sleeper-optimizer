import type { CorrelationKind, CorrelationNote, CorrelationPlayerRef, LineupEntry, PlayerEvaluation, TiebreakDecision } from '../../shared/types.js';
import { normalizeTeam } from '../services/player-mapping.js';

/**
 * A relationship is only reported when both sides carry real projected scoring that can overlap. Below these the player
 * is a low-volume piece whose outcome barely moves with the other player's. Values are in this league's projected points.
 */
export const MIN_QB_PASSING_POINTS = 8;
export const MIN_CATCHER_RECEIVING_POINTS = 4;
export const MIN_OFFENSE_POINTS = 8;

const RECEIVING_KEYS = new Set(['rec', 'rec_yd', 'rec_td', 'rec_2pt']);
const PASSING_KEYS = new Set(['pass_yd', 'pass_td', 'pass_2pt']);

export type Posture = 'FAVORITE' | 'UNDERDOG';

const positionOf = (player: PlayerEvaluation): string => {
  const position = player.positions[0] === 'DST' ? 'DEF' : player.positions[0];
  return position || '';
};

function componentPoints(player: PlayerEvaluation, keys: Set<string>): number | null {
  const components = player.scoringComponents;
  if (!components?.length) return null;
  const relevant = components.filter(component => component.modeled && component.sleeperKey && keys.has(component.sleeperKey));
  return relevant.reduce((sum, component) => sum + (component.projectedPoints ?? 0), 0);
}

const teamOf = (player: PlayerEvaluation): string => normalizeTeam(player.team) || '';

const isQuarterback = (player: PlayerEvaluation): boolean => positionOf(player) === 'QB' && (componentPoints(player, PASSING_KEYS) ?? 0) >= MIN_QB_PASSING_POINTS;

function isPassCatcher(player: PlayerEvaluation): boolean {
  const position = positionOf(player);
  if (position !== 'WR' && position !== 'TE' && position !== 'RB') return false;
  return (componentPoints(player, RECEIVING_KEYS) ?? 0) >= MIN_CATCHER_RECEIVING_POINTS;
}

const isMaterialOffense = (player: PlayerEvaluation): boolean => ['QB', 'RB', 'WR', 'TE'].includes(positionOf(player)) && (player.weeklyPoints ?? 0) >= MIN_OFFENSE_POINTS;

/** True when `mine` is a QB or pass catcher whose same-team counterpart starts for the opponent. */
function passingLink(mine: PlayerEvaluation, opponentStarters: PlayerEvaluation[]): PlayerEvaluation[] {
  const team = teamOf(mine);
  if (!team) return [];
  if (isQuarterback(mine)) return opponentStarters.filter(theirs => teamOf(theirs) === team && isPassCatcher(theirs));
  if (isPassCatcher(mine)) return opponentStarters.filter(theirs => teamOf(theirs) === team && isQuarterback(theirs));
  return [];
}

/**
 * A bounded score nudge (never larger than half a point, and below the league's decision band) applied to my roster players who
 * share an NFL team with one of my opponent's starters in a QB / pass-catcher relationship. Direction depends on the projected margin:
 * when I am ahead, a shared passing game narrows how far the week's football events can swing the margin (+ bonus); when I am behind,
 * I prefer the option that is NOT linked to my opponent (a negative bonus), because I need the margin to be able to move. The nudge
 * can only choose between genuinely close options; it can never outweigh a real projection gap.
 */
export function correlationBonusMap(myRoster: PlayerEvaluation[], opponentStarters: PlayerEvaluation[], band: number, posture: Posture | null): Map<string, number> {
  const bonus = new Map<string, number>();
  if (!posture) return bonus;
  const magnitude = Math.max(0, Math.min(band * 0.4, 0.5));
  if (magnitude <= 0) return bonus;
  for (const mine of myRoster) if (passingLink(mine, opponentStarters).length) bonus.set(mine.playerId, posture === 'FAVORITE' ? magnitude : -magnitude);
  return bonus;
}

const expectedOf = (player: PlayerEvaluation): number => player.expectedPoints ?? player.weeklyPoints ?? 0;
const round2 = (value: number) => Math.round(value * 100) / 100;
const f1 = (value: number | null | undefined) => value == null ? 'n/a' : value.toFixed(1);

/** Which of my players the tiebreak actually changed: compares the lineup with and without the nudge. */
export function buildTiebreaks(recommended: LineupEntry[], withoutBonus: LineupEntry[], bonus: Map<string, number>, opponentStarters: PlayerEvaluation[], posture: Posture | null, margin: number | null, band: number): TiebreakDecision[] {
  if (!posture || margin == null || !bonus.size) return [];
  const chosenIds = new Set(recommended.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const baselineIds = new Set(withoutBonus.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const ins = recommended.filter(entry => entry.player && !baselineIds.has(entry.player.playerId));
  const outs = withoutBonus.filter(entry => entry.player && !chosenIds.has(entry.player.playerId));
  const usedOuts = new Set<string>();
  const result: TiebreakDecision[] = [];
  for (const entry of ins) {
    const chosen = entry.player!;
    const alternativeEntry = outs.find(item => !usedOuts.has(item.player!.playerId) && positionOf(item.player!) === positionOf(chosen)) || outs.find(item => !usedOuts.has(item.player!.playerId));
    if (!alternativeEntry) continue;
    const alternative = alternativeEntry.player!;
    if (!bonus.has(chosen.playerId) && !bonus.has(alternative.playerId)) continue;
    usedOuts.add(alternative.playerId);
    const correlated = bonus.has(chosen.playerId) ? chosen : alternative;
    const partners = passingLink(correlated, opponentStarters);
    const partnerText = partners.map(partner => `${partner.name} (${partner.team})`).join(', ');
    const given = round2(expectedOf(alternative) - expectedOf(chosen));
    const explanation = posture === 'FAVORITE'
      ? `You are projected ahead by ${f1(margin)}. ${chosen.name} (${f1(expectedOf(chosen))}) and ${alternative.name} (${f1(expectedOf(alternative))}) were within the ${f1(band)}-point decision band, so the lineup used ${chosen.name}: he shares ${correlated.team} with your opponent's ${partnerText}, and when you are ahead a shared passing game narrows how far the week's results can move the margin. ${given > 0 ? `This gave up ${given.toFixed(2)} projected points.` : 'It did not cost projected points.'}`
      : `You are projected behind by ${f1(Math.abs(margin))}. ${chosen.name} (${f1(expectedOf(chosen))}) and ${alternative.name} (${f1(expectedOf(alternative))}) were within the ${f1(band)}-point decision band, so the lineup used ${chosen.name}: ${alternative.name} shares ${correlated.team} with your opponent's ${partnerText}, and when you are behind you need the margin to be able to move, which a player tied to your opponent's passing game does less of. ${given > 0 ? `This gave up ${given.toFixed(2)} projected points.` : 'It did not cost projected points.'}`;
    result.push({
      slot: entry.slot, chosenId: chosen.playerId, chosenName: chosen.name, alternativeId: alternative.playerId, alternativeName: alternative.name,
      chosenProjection: chosen.weeklyPoints, alternativeProjection: alternative.weeklyPoints, projectionGiven: given, band, posture, projectedMargin: margin,
      correlatedWith: partnerText, explanation
    });
  }
  return result;
}

interface Starter { player: PlayerEvaluation; slot: string; side: 'mine' | 'opponent' }

const ref = (starter: Starter): CorrelationPlayerRef => ({
  playerId: starter.player.playerId, name: starter.player.name, side: starter.side, position: positionOf(starter.player), team: starter.player.team, slot: starter.slot, projection: starter.player.weeklyPoints
});

const names = (starters: Starter[]): string => {
  const list = starters.map(starter => `${starter.player.name} (${positionOf(starter.player)}, ${f1(starter.player.weeklyPoints)})`);
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

const receiving = (starters: Starter[]): string => starters.map(starter => `${starter.player.name} ${f1(componentPoints(starter.player, RECEIVING_KEYS))}`).join(', ');

/**
 * Correlation notes between the two final lineups (starters only, material projections only). Notes are informational
 * unless one of the involved players was chosen by the tiebreak, in which case the note says which decision it changed.
 */
export function buildCorrelationNotes(myLineup: LineupEntry[], opponentLineup: LineupEntry[], tiebreaks: TiebreakDecision[] = []): CorrelationNote[] {
  const mine: Starter[] = myLineup.flatMap(entry => entry.player ? [{ player: entry.player, slot: entry.slot, side: 'mine' as const }] : []);
  const theirs: Starter[] = opponentLineup.flatMap(entry => entry.player ? [{ player: entry.player, slot: entry.slot, side: 'opponent' as const }] : []);
  const notes: CorrelationNote[] = [];
  const teams = [...new Set([...mine, ...theirs].map(starter => teamOf(starter.player)).filter(Boolean))].sort();
  const tiebreakFor = (involved: Starter[]) => tiebreaks.find(item => involved.some(starter => starter.player.playerId === item.chosenId));

  const push = (kind: CorrelationKind, title: string, team: string, involved: Starter[], explanation: string, overlap: string) => {
    const tiebreak = kind === 'CATCHER_VS_OPPONENT_QB' || kind === 'QB_VS_OPPONENT_CATCHER' ? tiebreakFor(involved) : undefined;
    notes.push({
      kind, title, team, players: involved.map(ref), explanation, overlap,
      effect: tiebreak ? 'DECISION_CHANGING' : 'INFORMATIONAL',
      effectNote: tiebreak
        ? `Decision-changing tiebreak: ${tiebreak.chosenName} over ${tiebreak.alternativeName} (${tiebreak.projectionGiven > 0 ? `${tiebreak.projectionGiven.toFixed(2)} projected points given up` : 'no projected points given up'}). ${tiebreak.explanation}`
        : 'Informational only: no lineup decision depended on this relationship.',
      appliedAsTiebreak: Boolean(tiebreak)
    });
  };

  for (const team of teams) {
    const myQbs = mine.filter(starter => teamOf(starter.player) === team && isQuarterback(starter.player));
    const myCatchers = mine.filter(starter => teamOf(starter.player) === team && isPassCatcher(starter.player));
    const theirQbs = theirs.filter(starter => teamOf(starter.player) === team && isQuarterback(starter.player));
    const theirCatchers = theirs.filter(starter => teamOf(starter.player) === team && isPassCatcher(starter.player));

    if (theirQbs.length && myCatchers.length) {
      push('CATCHER_VS_OPPONENT_QB', `Your ${team} pass catcher vs. opponent's ${team} QB`, team, [...myCatchers, ...theirQbs],
        `${names(myCatchers)} on your side and ${names(theirQbs)} on your opponent's side are both ${team} players. They can score on the same passing play: a completion from ${theirQbs[0].player.name} to your player adds points to both lineups at once, reducing the relative advantage you gain from that event. Your expected points are unchanged; what changes is how much a strong ${team} passing game helps you compared with your opponent.`,
        `Your receiving points: ${receiving(myCatchers)}; opponent QB passing points: ${theirQbs.map(starter => `${starter.player.name} ${f1(componentPoints(starter.player, PASSING_KEYS))}`).join(', ')}.`);
    }
    if (myQbs.length && theirCatchers.length) {
      push('QB_VS_OPPONENT_CATCHER', `Your ${team} QB vs. opponent's ${team} pass catcher`, team, [...myQbs, ...theirCatchers],
        `${names(myQbs)} on your side and ${names(theirCatchers)} on your opponent's side are both ${team} players. When ${myQbs[0].player.name} completes a pass to your opponent's player, both lineups score from that one play, reducing the relative advantage you gain from your quarterback's production. Your expected points are unchanged.`,
        `Your QB passing points: ${myQbs.map(starter => `${starter.player.name} ${f1(componentPoints(starter.player, PASSING_KEYS))}`).join(', ')}; opponent receiving points: ${receiving(theirCatchers)}.`);
    }

    for (const [side, qbs, catchers] of [['mine', myQbs, myCatchers], ['opponent', theirQbs, theirCatchers]] as const) {
      const owner = side === 'mine' ? 'You start' : 'Your opponent starts';
      if (qbs.length && catchers.length) {
        push(side === 'mine' ? 'MY_STACK' : 'OPPONENT_STACK', `${side === 'mine' ? 'Your' : "Opponent's"} ${team} QB stack`, team, [...qbs, ...catchers],
          `${owner} ${names(qbs)} with ${names(catchers)}, all ${team}. When the ${team} passing game hits, ${catchers.length > 1 ? 'several' : 'both'} of ${side === 'mine' ? 'your' : "your opponent's"} starters score together, and when it stalls they fall together. Expected points are unchanged, but ${side === 'mine' ? 'your' : "your opponent's"} outcomes are more spread out.`,
          `QB passing points ${qbs.map(starter => f1(componentPoints(starter.player, PASSING_KEYS))).join(', ')}; pass-catcher receiving points ${receiving(catchers)}.`);
      } else if (!qbs.length && catchers.length > 1) {
        push(side === 'mine' ? 'MY_SHARED_QB' : 'OPPONENT_SHARED_QB', `${side === 'mine' ? 'Your' : "Opponent's"} ${catchers.length} ${team} pass catchers`, team, catchers,
          `${owner} ${names(catchers)}, all ${team}. They draw their targets from the same offense and the same quarterback, so their production tends to rise and fall with one passing game. Expected points are unchanged, but ${side === 'mine' ? 'your' : "your opponent's"} outcomes are more concentrated in one game script.`,
          `Receiving points ${receiving(catchers)}.`);
      }
    }
  }

  const defenseNotes = (defenders: Starter[], offense: Starter[], defenderSide: 'mine' | 'opponent') => {
    for (const defense of defenders) {
      if (positionOf(defense.player) !== 'DEF' || !defense.player.opponent) continue;
      const faced = normalizeTeam(defense.player.opponent) || '';
      const facing = offense.filter(starter => teamOf(starter.player) === faced && isMaterialOffense(starter.player));
      if (!facing.length) continue;
      const mineDefense = defenderSide === 'mine';
      push(mineDefense ? 'MY_DEFENSE_VS_OPPONENT_OFFENSE' : 'OPPONENT_DEFENSE_VS_MY_OFFENSE', `${mineDefense ? 'Your' : "Opponent's"} ${defense.player.team} defense vs. ${mineDefense ? "opponent's" : 'your'} ${faced} offense`, faced, [defense, ...facing],
        `${mineDefense ? 'Your' : "Your opponent's"} ${defense.player.name} defense plays ${faced}, the team of ${mineDefense ? "your opponent's" : 'your'} ${names(facing)}. The defense's sacks, takeaways and points allowed depend on how that offense performs, so a poor game from ${facing[0].player.name} usually comes with a strong game from the defense, and a big game comes with a weak one. The same football events move both sides of this matchup together, widening the range of possible margins without changing expected points.`,
        `Defense projection ${f1(defense.player.weeklyPoints)}; opposing offensive projections ${facing.map(starter => `${starter.player.name} ${f1(starter.player.weeklyPoints)}`).join(', ')}.`);
    }
  };
  defenseNotes(mine, theirs, 'mine');
  defenseNotes(theirs, mine, 'opponent');
  return notes;
}

/** Same relationships between one candidate (a waiver add) and the opponent's starters; used only as supporting context. */
export function candidateRelationship(candidate: PlayerEvaluation, opponentStarters: PlayerEvaluation[]): string | null {
  const linked = passingLink(candidate, opponentStarters);
  if (linked.length) {
    const kind = isQuarterback(candidate) ? 'quarterback' : 'pass catcher';
    return `As a ${candidate.team} ${kind}, ${candidate.name} would share a passing game with your opponent's ${linked.map(player => `${player.name}`).join(', ')}, which reduces the relative advantage of his production.`;
  }
  if (positionOf(candidate) === 'DEF' && candidate.opponent) {
    const faced = normalizeTeam(candidate.opponent) || '';
    const facing = opponentStarters.filter(player => teamOf(player) === faced && isMaterialOffense(player));
    if (facing.length) return `${candidate.name} would face ${faced}, the team of your opponent's ${facing.map(player => player.name).join(', ')}.`;
  }
  return null;
}
