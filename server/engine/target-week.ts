import type { WeekSelection } from '../../shared/types.js';
import type { GameRow } from '../providers/nflverse.js';
import { normalizeTeam } from '../services/player-mapping.js';
import { easternToIso } from '../utils/time.js';

export interface RelevantPlayer { id: string; name: string; team: string | null }

export interface TargetWeekInput {
  sleeperWeek: number;
  seasonType: string;
  season: string;
  games: GameRow[];
  players: RelevantPlayer[];
  now: Date;
}

export type WeekSelectionCore = Omit<WeekSelection, 'matchupAvailable' | 'matchupNote'>;

/** Scheduled kickoff instant (UTC ms). A game with no published time counts as unplayed until the end of its Eastern gameday. */
export function kickoffMs(game: GameRow): number | null {
  if (!game.gameday) return null;
  const iso = easternToIso(game.gameday, game.gametime || '23:59');
  return iso ? Date.parse(iso) : null;
}

function gamesByTeam(games: GameRow[], season: string, week: number): Map<string, GameRow> {
  const result = new Map<string, GameRow>();
  for (const game of games) {
    if (String(game.season) !== season || Number(game.week) !== week) continue;
    for (const team of [game.home_team, game.away_team]) { const normalized = normalizeTeam(team); if (normalized) result.set(normalized, game); }
  }
  return result;
}

/**
 * Picks the single week every provider must use. Stays on Sleeper's week while any relevant rostered player still has an
 * unstarted game that week; advances only once every relevant game has kicked off (byes and teamless players don't count).
 */
export function selectTargetWeek(input: TargetWeekInput): WeekSelectionCore {
  const { sleeperWeek, seasonType, season, games, players, now } = input;
  const empty = { total: 0, notKickedOff: 0, kickedOff: 0, bye: 0, nextKickoff: null as string | null };
  const stay = (reason: string): WeekSelectionCore => ({ sleeperWeek, targetWeek: sleeperWeek, advanced: false, reason, message: null, relevantGames: empty });

  if (seasonType !== 'regular') return stay(`Sleeper reports a ${seasonType || 'non-regular'} season phase, so the week is not auto-advanced.`);
  const current = gamesByTeam(games, season, sleeperWeek);
  if (!current.size) return stay(`The NFL schedule has no Week ${sleeperWeek} games available, so Sleeper's week is used as-is.`);

  const nowMs = now.getTime();
  const seenGames = new Set<string>();
  let bye = 0;
  let notKickedOff = 0;
  let nextKickoff: number | null = null;
  const relevantTeams = new Map<string, GameRow>();
  for (const player of players) {
    const team = normalizeTeam(player.team);
    if (!team) continue;
    const game = current.get(team);
    if (!game) { bye += 1; continue; }
    relevantTeams.set(team, game);
  }
  for (const game of relevantTeams.values()) {
    if (seenGames.has(game.game_id)) continue;
    seenGames.add(game.game_id);
    const ms = kickoffMs(game);
    if (ms == null || ms > nowMs) { notKickedOff += 1; if (ms != null && (nextKickoff == null || ms < nextKickoff)) nextKickoff = ms; }
  }
  const total = seenGames.size;
  const relevantGames = { total, notKickedOff, kickedOff: total - notKickedOff, bye, nextKickoff: nextKickoff == null ? null : new Date(nextKickoff).toISOString() };

  if (notKickedOff > 0) {
    return { sleeperWeek, targetWeek: sleeperWeek, advanced: false, relevantGames,
      reason: `${notKickedOff} of ${total} relevant Week ${sleeperWeek} game${total === 1 ? '' : 's'} ha${notKickedOff === 1 ? 's' : 've'} not kicked off yet.`, message: null };
  }
  const nextWeek = sleeperWeek + 1;
  if (!gamesByTeam(games, season, nextWeek).size) {
    return { sleeperWeek, targetWeek: sleeperWeek, advanced: false, relevantGames,
      reason: `All relevant Week ${sleeperWeek} games have kicked off, but the NFL schedule has no Week ${nextWeek} games, so Week ${sleeperWeek} is kept.`, message: null };
  }
  return { sleeperWeek, targetWeek: nextWeek, advanced: true, relevantGames,
    reason: total
      ? `All ${total} relevant Week ${sleeperWeek} game${total === 1 ? ' has' : 's have'} kicked off or finished.`
      : `None of your relevant players have a Week ${sleeperWeek} game left to play (bye weeks or no scheduled game).`,
    message: `Sleeper is currently on Week ${sleeperWeek}, but all relevant Week ${sleeperWeek} games have kicked off. Optimizing Week ${nextWeek} instead.` };
}
