import { describe, expect, it } from 'vitest';
import type { GameRow } from '../providers/nflverse.js';
import { buildSupportingContext } from './analysis.js';
import { selectTargetWeek } from './target-week.js';

const game = (id: string, week: number, gameday: string, gametime: string, away: string, home: string): GameRow => ({ game_id: id, season: '2026', week: String(week), gameday, gametime, away_team: away, home_team: home });
const SCHEDULE: GameRow[] = [
  game('t', 3, '2026-09-24', '20:15', 'TEN', 'HOU'),
  game('e', 3, '2026-09-27', '13:00', 'NYJ', 'BUF'),
  game('l', 3, '2026-09-27', '16:25', 'SEA', 'SF'),
  game('n', 3, '2026-09-27', '20:20', 'KC', 'DEN'),
  game('m', 3, '2026-09-28', '20:15', 'PHI', 'DAL'),
  game('w4a', 4, '2026-10-01', '20:15', 'TEN', 'PHI'),
  game('w4b', 4, '2026-10-04', '13:00', 'NYJ', 'BUF'),
  game('w4c', 4, '2026-10-04', '13:00', 'SEA', 'SF'),
  game('w4d', 4, '2026-10-04', '13:00', 'KC', 'DEN')
];
const P = (team: string | null, id = team || 'x') => ({ id, name: id, team });
const pick = (now: string, teams: Array<string | null>, games = SCHEDULE, week = 3) =>
  selectTargetWeek({ sleeperWeek: week, seasonType: 'regular', season: '2026', games, players: teams.map(team => P(team)), now: new Date(now) });

describe('automatic target-week selection', () => {
  it('Sunday morning stays on the current week', () => {
    const result = pick('2026-09-27T14:00:00Z', ['BUF', 'SEA', 'KC', 'HOU']);
    expect(result).toMatchObject({ targetWeek: 3, advanced: false });
  });

  it('Sunday afternoon with some relevant games unplayed stays on the current week', () => {
    const result = pick('2026-09-27T21:00:00Z', ['BUF', 'SF', 'KC', 'DAL']);
    expect(result.targetWeek).toBe(3);
    expect(result.relevantGames).toMatchObject({ notKickedOff: 2, kickedOff: 2 });
  });

  it('Monday night with one relevant player unplayed stays on the current week', () => {
    const result = pick('2026-09-29T00:00:00Z', ['BUF', 'KC', 'PHI']);
    expect(result).toMatchObject({ targetWeek: 3, advanced: false });
    expect(result.relevantGames.notKickedOff).toBe(1);
    expect(result.relevantGames.nextKickoff).toBe('2026-09-29T00:15:00.000Z');
  });

  it('Monday after every relevant game has kicked off advances to the next week', () => {
    const result = pick('2026-09-29T00:16:00Z', ['BUF', 'KC', 'PHI']);
    expect(result).toMatchObject({ sleeperWeek: 3, targetWeek: 4, advanced: true });
    expect(result.message).toBe('Sleeper is currently on Week 3, but all relevant Week 3 games have kicked off. Optimizing Week 4 instead.');
  });

  it('advances when every relevant game has finished (Tuesday)', () => {
    const result = pick('2026-09-29T15:00:00Z', ['BUF', 'SF', 'KC', 'PHI', 'HOU', 'TEN']);
    expect(result).toMatchObject({ targetWeek: 4, advanced: true });
    expect(result.relevantGames.kickedOff).toBe(result.relevantGames.total);
  });

  it('a bye-week or teamless player does not keep the current week active', () => {
    const result = pick('2026-09-29T00:16:00Z', ['BUF', 'MIA', 'PHI', null]);
    expect(result.targetWeek).toBe(4);
    expect(result.relevantGames.bye).toBe(1);
    const onlyBye = pick('2026-09-27T14:00:00Z', ['MIA']);
    expect(onlyBye.relevantGames.notKickedOff).toBe(0);
  });

  it('a rescheduled game is judged by its new kickoff', () => {
    const moved = SCHEDULE.map(entry => entry.game_id === 'm' ? { ...entry, gameday: '2026-09-30', gametime: '20:00' } : entry);
    expect(pick('2026-09-29T00:16:00Z', ['BUF', 'PHI'], moved).targetWeek).toBe(3);
    expect(pick('2026-10-01T01:00:00Z', ['BUF', 'PHI'], moved).targetWeek).toBe(4);
  });

  it('a game with no published kick time is unplayed until its gameday ends', () => {
    const tbd = SCHEDULE.map(entry => entry.game_id === 'm' ? { ...entry, gametime: '' } : entry);
    expect(pick('2026-09-29T01:00:00Z', ['PHI'], tbd).targetWeek).toBe(3);
    expect(pick('2026-09-29T05:00:00Z', ['PHI'], tbd).targetWeek).toBe(4);
  });

  it('never advances outside the regular season or without a next-week schedule', () => {
    const post = selectTargetWeek({ sleeperWeek: 3, seasonType: 'post', season: '2026', games: SCHEDULE, players: [P('BUF')], now: new Date('2026-09-30T00:00:00Z') });
    expect(post.targetWeek).toBe(3);
    const noNext = pick('2026-09-30T00:00:00Z', ['BUF'], SCHEDULE.filter(entry => entry.week === '3'));
    expect(noNext).toMatchObject({ targetWeek: 3, advanced: false });
    expect(pick('2026-09-30T00:00:00Z', ['BUF'], []).targetWeek).toBe(3);
  });
});

describe('week-consistent supporting data', () => {
  const injury = (week: number, status: string) => ({ season: '2026', week: String(week), team: 'PHI', gsis_id: 'G1', full_name: 'Hall', report_status: status, report_primary_injury: 'Knee', practice_status: 'Did Not Participate In Practice' });
  const ctx = (week: number) => buildSupportingContext('2026', week, SCHEDULE, [], [injury(3, 'Questionable'), injury(4, 'Out')], [], []);

  it('nflverse schedule and opponent lookup follow the target week, not the Sleeper week', () => {
    expect(ctx(3).scheduleByTeam.get('PHI')?.opponent).toBe('DAL');
    expect(ctx(4).scheduleByTeam.get('PHI')?.opponent).toBe('TEN');
    expect(ctx(4).scheduleByTeam.get('PHI')?.gameTime).toBe('2026-10-02T00:15:00.000Z');
  });

  it('a Week 4 injury status never influences a Week 3 optimization (and vice versa)', () => {
    expect(ctx(3).injuriesByGsis.get('G1')?.report_status).toBe('Questionable');
    expect(ctx(4).injuriesByGsis.get('G1')?.report_status).toBe('Out');
  });
});

describe('team-code and depth-chart hygiene', () => {
  const game = (home: string, away: string) => ({ game_id: 'g', season: '2026', week: '4', gameday: '2026-10-04', gametime: '13:00', home_team: home, away_team: away });

  it('joins nflverse (JAX, LA) and Sleeper (JAX, LAR) team codes in both directions', () => {
    const ctx = buildSupportingContext('2026', 4, [game('JAX', 'LA')], [], [], [], []);
    expect(ctx.scheduleByTeam.get('JAC')?.opponent).toBe('LAR');
    expect(ctx.scheduleByTeam.get('LAR')?.opponent).toBe('JAX');
    expect(ctx.scheduleByTeam.get('JAC')?.gameTime).toBe('2026-10-04T17:00:00.000Z');
  });

  it('ignores depth-chart snapshots older than the freshness window and keeps the latest snapshot per player', () => {
    const row = (dt: string, pos_rank: string) => ({ team: 'BUF', player_name: 'X', espn_id: '1', gsis_id: 'G9', pos_abb: 'WR', pos_rank, dt });
    const now = new Date('2026-09-29T12:00:00Z');
    const ctx = buildSupportingContext('2026', 4, [], [row('2026-09-01T00:00:00Z', '1'), row('2026-09-27T00:00:00Z', '2'), row('2026-09-20T00:00:00Z', '3')], [], [], [], now);
    expect(ctx.depthByGsis.get('G9')?.pos_rank).toBe('2');
    const stale = buildSupportingContext('2026', 4, [], [row('2026-09-01T00:00:00Z', '1')], [], [], [], now);
    expect(stale.depthByGsis.has('G9')).toBe(false);
  });
});
