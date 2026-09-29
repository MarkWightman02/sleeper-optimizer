import type { CorrelationNote, LineupEntry, PlayerEvaluation } from '../../shared/types.js';

const PASS_CATCHERS = new Set(['WR', 'TE', 'RB']);

function isStack(a: PlayerEvaluation, b: PlayerEvaluation): boolean {
  const posA = a.positions[0];
  const posB = b.positions[0];
  return (posA === 'QB' && PASS_CATCHERS.has(posB)) || (posB === 'QB' && PASS_CATCHERS.has(posA));
}

/**
 * A bounded score nudge (never larger than the league's own decision band) applied to my roster players
 * who share an NFL team with one of my current weekly opponent's starters in a QB/pass-catcher relationship.
 * Because the nudge is capped below the decision band, it can tip a genuinely close lineup choice between two
 * of my own players but can never outweigh a real projection gap — see optimizer.ts's `decisionBand`.
 */
export function correlationBonusMap(myRoster: PlayerEvaluation[], opponentStarters: PlayerEvaluation[], band: number): Map<string, number> {
  const bonus = new Map<string, number>();
  const magnitude = Math.max(0, Math.min(band * 0.4, 0.5));
  if (magnitude <= 0) return bonus;
  for (const mine of myRoster) {
    if (!mine.team) continue;
    const stacked = opponentStarters.some(theirs => theirs.team === mine.team && isStack(mine, theirs));
    if (stacked) bonus.set(mine.playerId, magnitude);
  }
  return bonus;
}

function explain(mine: PlayerEvaluation, theirs: PlayerEvaluation, appliedAsTiebreak: boolean): CorrelationNote {
  const qb = mine.positions[0] === 'QB' ? mine : theirs;
  const catcher = mine.positions[0] === 'QB' ? theirs : mine;
  const qbOwner = qb.playerId === mine.playerId ? 'You' : 'Your opponent';
  const catcherOwner = catcher.playerId === mine.playerId ? 'you' : 'your opponent';
  return {
    myPlayerId: mine.playerId,
    myPlayerName: mine.name,
    opponentPlayerId: theirs.playerId,
    opponentPlayerName: theirs.name,
    team: mine.team || '',
    relationship: `${qb.positions[0]}/${catcher.positions[0]} stack`,
    explanation: `${qbOwner} start${qbOwner === 'You' ? '' : 's'} ${qb.name} at quarterback and ${catcherOwner === 'you' ? 'you start' : 'your opponent starts'} ${catcher.name}, both on the ${mine.team}. A passing score between them helps both fantasy lineups simultaneously — this does not cancel out, but it means the underlying NFL outcomes are linked.${appliedAsTiebreak ? ' Because the two lineup options were close in projected points, this relationship was used as a tiebreaker.' : ''}`,
    appliedAsTiebreak
  };
}

/** Informational correlation notes between the two final lineups, for the Matchup view. Does not itself change any recommendation. */
export function buildCorrelationNotes(myLineup: LineupEntry[], opponentLineup: LineupEntry[], tiebrokenPlayerIds: Set<string>): CorrelationNote[] {
  const notes: CorrelationNote[] = [];
  const mine = myLineup.flatMap(entry => entry.player ? [entry.player] : []);
  const theirs = opponentLineup.flatMap(entry => entry.player ? [entry.player] : []);
  for (const myPlayer of mine) {
    if (!myPlayer.team) continue;
    for (const theirPlayer of theirs) {
      if (theirPlayer.team !== myPlayer.team || !isStack(myPlayer, theirPlayer)) continue;
      notes.push(explain(myPlayer, theirPlayer, tiebrokenPlayerIds.has(myPlayer.playerId)));
    }
  }
  return notes;
}
