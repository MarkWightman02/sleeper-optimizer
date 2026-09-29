import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SleeperMatchup } from '../../shared/types.js';

const mocks = vi.hoisted(() => ({
  getMatchups: vi.fn(), loadEspn: vi.fn(), loadNfl: vi.fn()
}));

vi.mock('../db.js', () => ({ getSleeperCacheInfo: () => ({ count: 0, fetchedAt: null }), getPlayerMappings: () => [], upsertPlayerMapping: () => undefined, deletePlayerMapping: () => undefined, getProviderCache: () => null, putProviderCache: () => new Date().toISOString() }));
vi.mock('../providers/espn.js', () => ({ loadEspnProjections: mocks.loadEspn }));
vi.mock('../providers/nflverse.js', () => ({ loadNflverseBundle: mocks.loadNfl }));
vi.mock('../providers/news.js', () => ({
  loadEspnNews: async () => ({ byAthleteId: new Map(), outcome: { name: 'espn news', kind: 'news', status: 'SUCCESS', retrievedAt: null } }),
  loadRotoBallerNews: async () => ({ items: [], outcome: { name: 'roto', kind: 'news', status: 'SUCCESS', retrievedAt: null } }),
  matchNewsByName: () => new Map()
}));
vi.mock('../services/crosswalk.js', () => ({ loadCrosswalk: async () => ({ index: { bySleeperId: new Map(), byGsisId: new Map(), byEspnId: new Map(), rows: [] }, outcome: { name: 'xw', kind: 'identity', status: 'SUCCESS', retrievedAt: null } }) }));
vi.mock('../services/player-mapping.js', async importOriginal => ({ ...(await importOriginal<object>()), resolvePlayerIdentities: () => ({ bySleeperId: new Map(), diagnostics: [] }) }));
vi.mock('../services/sleeper.js', () => ({
  sleeperApi: {
    getState: async () => ({ week: 3, season: '2026', season_type: 'regular' }),
    getLeague: async () => ({ league_id: 'L', name: 'L', season: '2026', roster_positions: ['RB', 'BN'], scoring_settings: {} }),
    getRosters: async () => [
      { roster_id: 1, owner_id: 'me', players: ['a', 'b'], starters: ['a'], reserve: [], taxi: [] },
      { roster_id: 2, owner_id: 'opp', players: ['c'], starters: ['c'], reserve: [], taxi: [] }
    ],
    getLeagueUsers: async () => [],
    getMatchups: mocks.getMatchups,
    getPlayers: async () => ({ retrievedAt: null, stale: false, players: {
      a: { player_id: 'a', full_name: 'Hall', team: 'PHI', position: 'RB', fantasy_positions: ['RB'], active: true, injury_status: 'Out' },
      b: { player_id: 'b', full_name: 'Henderson', team: 'BUF', position: 'RB', fantasy_positions: ['RB'], active: true },
      c: { player_id: 'c', full_name: 'Opp', team: 'DAL', position: 'RB', fantasy_positions: ['RB'], active: true }
    } })
  }
}));

import { runAnalysis } from './analysis.js';

const game = (id: string, week: number, gameday: string, gametime: string, away: string, home: string) => ({ game_id: id, season: '2026', week: String(week), gameday, gametime, away_team: away, home_team: home });
const bundle = {
  games: [game('w3a', 3, '2026-09-27', '13:00', 'PHI', 'DAL'), game('w3b', 3, '2026-09-28', '20:15', 'NYJ', 'BUF'), game('w4a', 4, '2026-10-04', '13:00', 'PHI', 'BUF'), game('w4b', 4, '2026-10-04', '13:00', 'NYJ', 'DAL')],
  depthCharts: [], snapCounts: [], weeklyStats: [], outcomes: [],
  injuries: [{ season: '2026', week: '4', team: 'PHI', gsis_id: 'G', full_name: 'Hall', report_status: 'Out', report_primary_injury: 'Knee', practice_status: 'DNP' }]
};
const config = { username: 'u', userId: 'me', leagueId: 'L', leagueName: 'L', season: '2026' };
const weekMatchups = (week: number): SleeperMatchup[] => week === 4
  ? [{ roster_id: 1, matchup_id: 9, players: ['a', 'b'], starters: ['0'] }, { roster_id: 2, matchup_id: 9, players: ['c'], starters: ['c'] }]
  : [{ roster_id: 1, matchup_id: 5, players: ['a', 'b'], starters: ['a'] }, { roster_id: 2, matchup_id: 5, players: ['c'], starters: ['c'] }];

async function run(now: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  try { return await runAnalysis(config, () => undefined); } finally { vi.useRealTimers(); }
}

beforeEach(() => {
  mocks.getMatchups.mockReset().mockImplementation(async (_league: string, week: number) => weekMatchups(week));
  mocks.loadNfl.mockReset().mockResolvedValue(bundle);
  mocks.loadEspn.mockReset().mockResolvedValue({ data: new Map(), rankings: new Map(), news: new Map(), outcome: { name: 'ESPN', kind: 'projection', status: 'SUCCESS', retrievedAt: null } });
});

describe('runAnalysis target-week propagation', () => {
  it('Monday after all relevant games kicked off: targetWeek 4 goes to ESPN, matchups and opponent lookup, and Sleeper week stays 3', async () => {
    const result = await run('2026-09-29T14:00:00Z');
    expect(result.weekSelection).toMatchObject({ sleeperWeek: 3, targetWeek: 4, advanced: true, matchupAvailable: true });
    expect(result.week).toBe(4);
    expect(result.diagnostics.week).toBe(4);
    expect(mocks.loadEspn.mock.calls[0][1]).toBe(4);
    expect(mocks.getMatchups).toHaveBeenCalledTimes(1);
    expect(mocks.getMatchups.mock.calls[0][1]).toBe(4);
    expect(result.matchupAnalysis?.opponentRosterId).toBe(2);
    expect(mocks.loadNfl.mock.calls[0][0]).toBe('2026');
    const hall = [...result.recommendedLineup, ...result.bench].map(entry => 'player' in entry ? entry.player : entry).find(player => player?.name === 'Hall');
    expect(hall?.opponent).toBe('BUF');
  });

  it('Monday before the last relevant game: current week 3, Week 4 injury row ignored', async () => {
    const result = await run('2026-09-28T22:00:00Z');
    expect(result.weekSelection).toMatchObject({ targetWeek: 3, advanced: false });
    expect(mocks.loadEspn.mock.calls[0][1]).toBe(3);
    expect(mocks.getMatchups.mock.calls[0][1]).toBe(3);
    const allPlayers = [...result.recommendedLineup.map(entry => entry.player), ...result.bench];
    const hall = allPlayers.find(player => player?.name === 'Hall');
    expect(hall?.opponent).toBe('DAL');
    expect(JSON.stringify(hall?.availability || {})).not.toMatch(/Knee/);
  });

  it('next-week matchup unpublished: still optimizes the roster, no fabricated opponent', async () => {
    mocks.getMatchups.mockImplementation(async (_league: string, week: number) => week === 4 ? [] : weekMatchups(week));
    const result = await run('2026-09-29T14:00:00Z');
    expect(result.week).toBe(4);
    expect(result.matchupAnalysis).toBeNull();
    expect(result.weekSelection).toMatchObject({ matchupAvailable: false });
    expect(result.weekSelection?.matchupNote).toMatch(/has not published the Week 4 matchup/);
    expect(result.recommendedLineup.length).toBeGreaterThan(0);
  });

  it('next-week matchup request failing degrades the same way', async () => {
    mocks.getMatchups.mockRejectedValue(new Error('HTTP 500'));
    const result = await run('2026-09-29T14:00:00Z');
    expect(result.matchupAnalysis).toBeNull();
    expect(result.weekSelection?.matchupNote).toMatch(/could not be loaded/);
  });
});
