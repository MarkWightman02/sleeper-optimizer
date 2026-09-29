import { randomUUID } from 'node:crypto';
import type {
  AnalysisDiagnostics, AnalysisResult, AppConfig, CorrelationNote, LeagueTeamView, MappingDiagnostic, MatchupAnalysis, MatchupTeamLine,
  NewsItem, PlayerEvaluation, ProgressEvent, RankingValue, SleeperLeague, SleeperPlayer, SleeperRoster, SleeperMatchup, SleeperUser, SourceStatus, RoleEvidence, WeekSelection, SupportingDataPoint
} from '../../shared/types.js';
import { getSleeperCacheInfo } from '../db.js';
import { loadEspnProjections } from '../providers/espn.js';
import type { DepthChartRow, GameRow, InjuryRow, WeeklyStatRow } from '../providers/nflverse.js';
import { loadNflverseBundle } from '../providers/nflverse.js';
import { loadEspnNews, loadRotoBallerNews, matchNewsByName } from '../providers/news.js';
import { STALE_FALLBACK_DETAIL } from '../providers/freshness.js';
import type { ExternalPlayerData, SourceOutcome } from '../providers/types.js';
import { loadCrosswalk } from '../services/crosswalk.js';
import { normalizePlayerName, normalizeTeam, resolvePlayerIdentities } from '../services/player-mapping.js';
import { sleeperApi } from '../services/sleeper.js';
import { easternToIso } from '../utils/time.js';
import { buildCorrelationNotes, correlationBonusMap } from './correlation.js';
import { combineProjections, computeConfidence } from './consensus.js';
import { assessAvailability, availabilityFields } from './availability.js';
import { attachLineupDecisions } from './decisions.js';
import { selectTargetWeek } from './target-week.js';
import { assessRole } from './role.js';
import { inferAcquisition, inferWaiverRules, recentDropsFromTransactions } from './waiver.js';
import { applyReplacementValues, calculateReplacementLevels, decisionBand, lineupExpectedTotal, lineupTotal, optimizeIfEveryonePlays, optimizeLineup, searchTransactions, starterSlots } from './optimizer.js';

type Progress = (event: ProgressEvent) => void;
const fantasyPositions = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'DE', 'DT', 'LB', 'DB', 'CB', 'S', 'FS', 'SS']);

function getPositions(player: SleeperPlayer): string[] {
  const positions = player.fantasy_positions?.length ? player.fantasy_positions : player.position ? [player.position] : [];
  return [...new Set(positions.map(position => position === 'DST' ? 'DEF' : position))];
}

function playerName(id: string, player?: SleeperPlayer): string {
  return player?.full_name || `${player?.first_name || ''} ${player?.last_name || ''}`.trim() || `Unknown player (${id})`;
}

function rosterStatus(id: string, roster: SleeperRoster): PlayerEvaluation['rosterStatus'] {
  if (roster.reserve?.includes(id)) return 'reserve';
  if (roster.taxi?.includes(id)) return 'taxi';
  if (roster.starters?.includes(id)) return 'starter';
  return 'bench';
}

interface AvailabilityContext { now: Date; sleeperRetrievedAt: string | null; sleeperStale: boolean; officialRetrievedAt: string | null; officialStale: boolean }

/** Per-player supporting context assembled once per run from nflverse datasets, keyed by gsis_id/name+team. */
interface SupportingContext {
  injuriesByGsis: Map<string, InjuryRow>;
  depthByGsis: Map<string, DepthChartRow>;
  scheduleByTeam: Map<string, { opponent: string; gameTime: string | null }>;
  recentFormByGsis: Map<string, WeeklyStatRow[]>;
  snapShareByNameTeam: Map<string, { pct: string; week: string }>;
  depthByTeamPos: Map<string, DepthChartRow[]>;
  /** Sleeper catalog entries by gsis_id, attached by runAnalysis; used to read teammates' injury status. */
  sleeperByGsis?: Map<string, SleeperPlayer>;
}

export function buildSupportingContext(season: string, week: number, games: GameRow[], depthCharts: DepthChartRow[], injuries: InjuryRow[], weeklyStats: WeeklyStatRow[], snapCounts: Array<Record<string, string>>): SupportingContext {
  const scheduleByTeam = new Map<string, { opponent: string; gameTime: string | null }>();
  for (const game of games) {
    if (String(game.season) !== season || Number(game.week) !== week) continue;
    const gameTime = game.gameday && game.gametime ? easternToIso(game.gameday, game.gametime) : null;
    scheduleByTeam.set(game.home_team, { opponent: game.away_team, gameTime });
    scheduleByTeam.set(game.away_team, { opponent: game.home_team, gameTime });
  }
  const injuriesByGsis = new Map<string, InjuryRow>();
  for (const row of injuries) if (Number(row.week) === week && row.gsis_id) injuriesByGsis.set(row.gsis_id, row);
  const depthByGsis = new Map<string, DepthChartRow>();
  for (const row of depthCharts) if (row.gsis_id && (!depthByGsis.has(row.gsis_id) || row.dt > depthByGsis.get(row.gsis_id)!.dt)) depthByGsis.set(row.gsis_id, row);
  const recentFormByGsis = new Map<string, WeeklyStatRow[]>();
  for (const row of weeklyStats) {
    if (!row.player_id || Number(row.week) >= week) continue;
    recentFormByGsis.set(row.player_id, [...(recentFormByGsis.get(row.player_id) || []), row]);
  }
  const snapShareByNameTeam = new Map<string, { pct: string; week: string }>();
  for (const row of snapCounts as Array<Record<string, string>>) {
    if (Number(row.week) !== week - 1) continue;
    const key = `${normalizePlayerName(row.player || '')}|${normalizeTeam(row.team)}`;
    snapShareByNameTeam.set(key, { pct: row.offense_pct, week: row.week });
  }
  const depthByTeamPos = new Map<string, DepthChartRow[]>();
  for (const row of depthByGsis.values()) {
    const key = `${normalizeTeam(row.team)}|${row.pos_abb}`;
    depthByTeamPos.set(key, [...(depthByTeamPos.get(key) || []), row]);
  }
  return { injuriesByGsis, depthByGsis, scheduleByTeam, recentFormByGsis, snapShareByNameTeam, depthByTeamPos };
}

function supportingDataFor(sleeper: SleeperPlayer | undefined, gsisId: string | null, context: SupportingContext): SupportingDataPoint[] {
  const notes: SupportingDataPoint[] = [];
  if (gsisId) {
    const depth = context.depthByGsis.get(gsisId);
    if (depth?.pos_rank) notes.push({ label: 'Depth chart', value: `${depth.pos_abb || sleeper?.position || 'position'} #${depth.pos_rank} on ${depth.team}`, source: 'nflverse depth charts' });
    const recent = context.recentFormByGsis.get(gsisId)?.slice(-3);
    if (recent?.length) {
      const points = recent.map(row => Number(row.fantasy_points_ppr || row.fantasy_points || 0).toFixed(1));
      notes.push({ label: 'Recent actual scoring', value: `Scored ${points.join(', ')} pts (standard PPR calculation, not this league's scoring) in the last ${points.length} game${points.length === 1 ? '' : 's'} played`, source: 'nflverse weekly stats' });
    }
  }
  if (sleeper) {
    const key = `${normalizePlayerName(sleeper.full_name || `${sleeper.first_name || ''} ${sleeper.last_name || ''}`)}|${normalizeTeam(sleeper.team)}`;
    const snap = context.snapShareByNameTeam.get(key);
    if (snap?.pct) notes.push({ label: 'Snap share', value: `Played ${Math.round(Number(snap.pct) * 100)}% of offensive snaps in week ${snap.week}`, source: 'nflverse snap counts' });
  }
  return notes;
}

const SLEEPER_TO_ROLE_STATUS: Record<string, string> = { out: 'OUT', ir: 'IR', pup: 'PUP', sus: 'SUSPENDED', doubtful: 'DOUBTFUL', questionable: 'QUESTIONABLE' };

function teammateStatus(row: DepthChartRow, context: SupportingContext): string {
  const official = row.gsis_id ? context.injuriesByGsis.get(row.gsis_id)?.report_status : null;
  const fromOfficial = official ? SLEEPER_TO_ROLE_STATUS[official.toLowerCase()] : undefined;
  const sleeperStatus = row.gsis_id ? context.sleeperByGsis?.get(row.gsis_id)?.injury_status : null;
  return fromOfficial || (sleeperStatus ? SLEEPER_TO_ROLE_STATUS[sleeperStatus.toLowerCase()] : undefined) || 'ACTIVE';
}

function roleFor(sleeper: SleeperPlayer | undefined, gsisId: string | null, position: string | undefined, context: SupportingContext): RoleEvidence {
  if (position === 'K' || position === 'DEF') return assessRole({ position: null, depthRank: null, snapPct: null, recentUsage: null, teammatesAhead: [] });
  const depth = gsisId ? context.depthByGsis.get(gsisId) : undefined;
  const depthRank = depth?.pos_rank ? Number(depth.pos_rank) : null;
  const snapKey = sleeper ? `${normalizePlayerName(sleeper.full_name || `${sleeper.first_name || ''} ${sleeper.last_name || ''}`)}|${normalizeTeam(sleeper.team)}` : '';
  const snap = context.snapShareByNameTeam.get(snapKey);
  const snapPct = snap?.pct != null && snap.pct !== '' && Number.isFinite(Number(snap.pct)) ? Number(snap.pct) * 100 : null;
  const last = gsisId ? context.recentFormByGsis.get(gsisId)?.slice(-1)[0] : undefined;
  const recentUsage = last ? { carries: Number(last.carries || 0), targets: Number(last.targets || 0), week: last.week } : null;
  const teammates = depth && depthRank != null
    ? (context.depthByTeamPos.get(`${normalizeTeam(depth.team)}|${depth.pos_abb}`) || [])
      .filter(row => row.gsis_id !== gsisId && Number(row.pos_rank) < depthRank)
      .map(row => ({ name: row.player_name, status: teammateStatus(row, context) }))
    : [];
  return assessRole({ position: position || null, depthRank, snapPct, recentUsage, teammatesAhead: teammates });
}

function makeEvaluation(
  id: string, player: SleeperPlayer | undefined, espn: ExternalPlayerData | undefined,
  status: PlayerEvaluation['rosterStatus'], ownedBy: number | null, identity: { espnId: string | null; gsisId: string | null; confidence: PlayerEvaluation['mappingConfidence']; method: string | null } | undefined,
  supporting: SupportingContext, news: NewsItem[], availabilityContext: AvailabilityContext
): PlayerEvaluation {
  const gsisId = identity?.gsisId || player?.gsis_id || null;
  const injuryRow = gsisId ? supporting.injuriesByGsis.get(gsisId) : undefined;
  const team = normalizeTeam(player?.team) || undefined;
  const schedule = team ? supporting.scheduleByTeam.get(team) : undefined;
  const availability = assessAvailability({ sleeper: player, official: injuryRow, news, gameTime: schedule?.gameTime || null, ...availabilityContext });
  const normalized = availability.status;
  const rawStatus = availability.rawStatus;
  const projections = espn?.projections || [];
  const rankings: RankingValue[] = espn?.rankings || [];
  const consensus = combineProjections(projections);
  const supportingData = [...(espn?.supportingData || []), ...supportingDataFor(player, gsisId, supporting)];
  const confidence = computeConfidence({
    projectionValues: projections.map(p => p.points),
    rankingCount: rankings.length,
    mappingConfidence: identity?.confidence || 'unmapped',
    normalizedInjuryStatus: normalized,
    coverage: consensus.coverage
  });

  const reasons: string[] = [];
  if (consensus.points != null) reasons.push(`Consensus projection: ${consensus.points.toFixed(1)} points from ${projections.length} source${projections.length === 1 ? '' : 's'} (${projections.map(p => `${p.source} ${p.points.toFixed(1)}`).join(', ')}).`);
  if (rankings.length) reasons.push(`Rankings: ${rankings.map(r => `${r.source} ${r.scoringType || ''} #${r.positionRank}`).join(', ')}.`);
  if (identity) reasons.push(`Player identity: ${identity.confidence}${identity.method ? ` via ${identity.method}` : ''}.`);
  if (normalized !== 'ACTIVE' || availability.riskFlag !== 'NONE') reasons.push(`Availability (kept separate from the projection): ${normalized}${rawStatus ? ` (${rawStatus})` : ''}, ${availability.injury || 'no injury detail'}; ${availability.policy}; confidence ${availability.confidence}.`);
  if (!projections.length) reasons.push('No projection source covered this player this week; no points were inferred.');
  for (const item of news.slice(0, 2)) reasons.push(`News (${item.source}): ${item.headline}`);
  const derived = availabilityFields(consensus.points, availability);

  return {
    playerId: id, espnId: identity?.espnId || null, name: playerName(id, player), team: player?.team || null,
    positions: getPositions(player || { player_id: id }), status: player?.status || null, injuryStatus: rawStatus,
    normalizedInjuryStatus: normalized, injuryBodyPart: availability.injury, practiceParticipation: availability.practice, injuryLastUpdated: availability.statusUpdatedAt,
    role: roleFor(player, gsisId, getPositions(player || { player_id: id })[0], supporting),
    probabilityOfPlaying: null, availability: derived.availability, expectedPoints: derived.expectedPoints,
    opponent: schedule?.opponent || null, gameTime: schedule?.gameTime || null,
    weeklyPoints: consensus.points, restOfSeasonValue: null,
    confidence, rosterStatus: status, ownedBy, isFreeAgent: ownedBy == null,
    eligible: player?.active !== false && derived.eligible, projectionCoverage: consensus.coverage,
    mappingConfidence: identity?.confidence || 'unmapped', mappingMethod: identity?.method || null,
    scoringComponents: espn?.scoringComponents || [], unsupportedScoringKeys: espn?.unsupportedScoringKeys || [],
    projections, rankings, newsItems: news, supportingData,
    metrics: {
      roster: { value: status, source: 'Sleeper' },
      status: { value: rawStatus || normalized, source: availability.statusSource },
      coverage: { value: consensus.coverage, source: 'Sleeper scoring × ESPN statistics' },
      ...(espn?.metrics || {})
    },
    reasons
  };
}

export function ownedIds(rosters: SleeperRoster[]): Set<string> {
  const ids = new Set<string>();
  for (const roster of rosters) for (const id of [...(roster.players || []), ...(roster.reserve || []), ...(roster.taxi || [])]) ids.add(id);
  return ids;
}

export function ownershipMap(rosters: SleeperRoster[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const roster of rosters) for (const id of [...(roster.players || []), ...(roster.reserve || []), ...(roster.taxi || [])]) result.set(id, roster.roster_id);
  return result;
}

function relevantFreeAgent(player: SleeperPlayer, usedSlots: string[]): boolean {
  const positions = getPositions(player);
  if (!positions.some(position => fantasyPositions.has(position))) return false;
  if (player.active === false || !player.team) return false;
  if (usedSlots.some(slot => ['IDP_FLEX', 'DL', 'LB', 'DB', 'DE', 'DT', 'CB', 'S'].includes(slot))) return true;
  return positions.some(position => ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(position));
}

export function calculateAvailableIds(players: Record<string, SleeperPlayer>, rosters: SleeperRoster[], usedSlots: string[]): string[] {
  const owned = ownedIds(rosters);
  return Object.keys(players).filter(id => !owned.has(id) && relevantFreeAgent(players[id], usedSlots));
}

function positionCounts(players: PlayerEvaluation[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const player of players) for (const position of player.positions.slice(0, 1)) result[position] = (result[position] || 0) + 1;
  return result;
}

function matchupLine(entry: { slot: string; player: PlayerEvaluation | null }): MatchupTeamLine {
  const player = entry.player;
  return {
    slot: entry.slot, playerId: player?.playerId || null, name: player?.name || 'No eligible player', positions: player?.positions || [],
    team: player?.team || null, opponent: player?.opponent || null, weeklyPoints: player?.weeklyPoints ?? null,
    status: player?.normalizedInjuryStatus || null, confidence: player?.confidence || 'Unavailable'
  };
}

function mappingDiagnostics(diagnostics: MappingDiagnostic[], relevantIds: Set<string>): { counts: { mapped: number; unmapped: number; ambiguous: number }; items: MappingDiagnostic[] } {
  const mapped = diagnostics.filter(item => item.status === 'mapped');
  const unmapped = diagnostics.filter(item => item.status === 'unmapped');
  const ambiguous = diagnostics.filter(item => item.status === 'ambiguous');
  const relevant = diagnostics.filter(item => !item.sleeperPlayerId || relevantIds.has(item.sleeperPlayerId));
  return { counts: { mapped: mapped.length, unmapped: unmapped.length, ambiguous: ambiguous.length }, items: relevant.slice(0, 300) };
}

function toDiagnosticStatus(outcome: SourceOutcome): SourceStatus { return { name: outcome.name, kind: outcome.kind, status: outcome.status, detail: outcome.detail, retrievedAt: outcome.retrievedAt, stale: outcome.stale }; }

export async function runAnalysis(config: AppConfig, progress: Progress, options: { forceRefresh?: boolean } = {}): Promise<AnalysisResult> {
  const analysisStartedAt = new Date().toISOString();
  progress({ stage: 'sleeper', message: 'Refreshing Sleeper league configuration…' });
  const state = await sleeperApi.getState();
  const league = await sleeperApi.getLeague(config.leagueId);
  progress({ stage: 'rosters', message: 'Loading every league roster…' });
  const [rosters, users] = await Promise.all([sleeperApi.getRosters(config.leagueId), sleeperApi.getLeagueUsers(config.leagueId)]);
  const myRoster = rosters.find(roster => roster.owner_id === config.userId);
  if (!myRoster) throw new Error('Your Sleeper user does not own a roster in the selected league. Choose another league in Settings.');

  progress({ stage: 'players', message: 'Loading the Sleeper player catalog…' });
  const catalog = await sleeperApi.getPlayers();
  const sleeperCatalogOutcome: SourceOutcome = { name: 'Sleeper player catalog (injury status)', kind: 'injury', status: 'SUCCESS', retrievedAt: catalog.retrievedAt, ...(catalog.stale ? { stale: true, detail: STALE_FALLBACK_DETAIL } : {}) };
  const warnings: string[] = catalog.stale ? ['Sleeper player catalog could not be refreshed this run; injury statuses come from an older cached copy and availability confidence is lowered.'] : [];
  progress({ stage: 'nflverse', message: 'Loading nflverse schedules, depth charts, injuries and recent usage…' });
  const nflverse = await loadNflverseBundle(state.season, true);

  const relevantRosterPlayers = (myRoster.players || [])
    .filter(id => !myRoster.reserve?.includes(id) && !myRoster.taxi?.includes(id) && catalog.players[id] && getPositions(catalog.players[id]).some(position => fantasyPositions.has(position)))
    .map(id => ({ id, name: playerName(id, catalog.players[id]), team: catalog.players[id].team || null }));
  const weekSelection: WeekSelection = {
    ...selectTargetWeek({ sleeperWeek: state.week, seasonType: state.season_type, season: state.season, games: nflverse.games, players: relevantRosterPlayers, now: new Date() }),
    matchupAvailable: false, matchupNote: null
  };
  const targetWeek = weekSelection.targetWeek;
  progress({ stage: 'week', message: weekSelection.advanced ? `Sleeper is on Week ${state.week}; all relevant games kicked off, so optimizing Week ${targetWeek}.` : `Optimizing Week ${targetWeek}: ${weekSelection.reason}` });

  progress({ stage: 'opponent', message: `Finding your Week ${targetWeek} opponent…` });
  let matchups: SleeperMatchup[] = [];
  let matchupFetchError: string | null = null;
  try { matchups = await sleeperApi.getMatchups(config.leagueId, targetWeek); }
  catch (error) { matchupFetchError = error instanceof Error ? error.message : String(error); }
  const myMatchup = matchups.find(item => item.roster_id === myRoster.roster_id);
  const opponentMatchup = myMatchup?.matchup_id != null ? matchups.find(item => item.matchup_id === myMatchup.matchup_id && item.roster_id !== myRoster.roster_id) : undefined;
  const opponentRoster = opponentMatchup ? rosters.find(roster => roster.roster_id === opponentMatchup.roster_id) : undefined;
  // Sleeper publishes unset future-week starters as "0"; only real player ids count.
  const matchupStarters = (myMatchup?.starters || []).filter(id => id && id !== '0');
  const currentStarterIds = matchupStarters.length ? matchupStarters : (myRoster.starters || []).filter(id => id && id !== '0');
  const opponentStarterIds = (opponentMatchup?.starters || []).filter(id => id && id !== '0');
  const opponentLineupIds = opponentStarterIds.length ? opponentStarterIds : (opponentRoster?.starters || []).filter(id => id && id !== '0');
  weekSelection.matchupAvailable = Boolean(opponentRoster);
  weekSelection.matchupNote = opponentRoster ? null : matchupFetchError
    ? `Sleeper's Week ${targetWeek} matchup could not be loaded (${matchupFetchError}). Opponent-specific analysis is unavailable.`
    : `Sleeper has not published the Week ${targetWeek} matchup yet, so opponent-specific analysis is unavailable until it does. Your roster is still fully optimized for Week ${targetWeek}.`;

  const ownership = ownershipMap(rosters);
  const freeIds = calculateAvailableIds(catalog.players, rosters, league.roster_positions);
  progress({ stage: 'availability', message: `Identified ${freeIds.length.toLocaleString()} unrostered, position-relevant free agents.`, current: freeIds.length });

  progress({ stage: 'mapping', message: 'Loading the player identity crosswalk and mapping Sleeper IDs…' });
  const crosswalk = await loadCrosswalk(options.forceRefresh);
  const identityResult = resolvePlayerIdentities(catalog.players, crosswalk.index);
  const espnIdToSleeperId = new Map<string, string>();
  for (const [sleeperId, match] of identityResult.bySleeperId) if (match.espnId) espnIdToSleeperId.set(match.espnId, sleeperId);

  progress({ stage: 'projections', message: `Fetching Week ${targetWeek} ESPN projections and expert rankings…` });
  // Every Optimize re-fetches all weekly/volatile sources (see providers/freshness.ts); only the ID crosswalk may be cached.
  const espnResult = await loadEspnProjections(state.season, targetWeek, league.scoring_settings || {}, espnIdToSleeperId, true);

  progress({ stage: 'news', message: 'Fetching recent player news…' });
  const [espnNews, rotoBallerNews] = await Promise.all([loadEspnNews(true), loadRotoBallerNews(true)]);
  const relevantIdSet = new Set([...(myRoster.players || []), ...freeIds, ...(opponentRoster?.players || [])]);
  const relevantPlayersForNews = [...relevantIdSet].map(id => ({ sleeperId: id, name: playerName(id, catalog.players[id]) }));
  const rotoBallerBySleeperId = matchNewsByName(rotoBallerNews.items, relevantPlayersForNews);
  const newsBySleeperId = new Map<string, NewsItem[]>();
  for (const id of relevantIdSet) {
    const espnId = identityResult.bySleeperId.get(id)?.espnId;
    const fromEspn = espnId ? espnNews.byAthleteId.get(Number(espnId)) || [] : [];
    const fromRoto = rotoBallerBySleeperId.get(id) || [];
    if (fromEspn.length || fromRoto.length) newsBySleeperId.set(id, [...fromEspn, ...fromRoto].slice(0, 5));
  }

  const outcomes: SourceOutcome[] = [crosswalk.outcome, sleeperCatalogOutcome, espnResult.outcome, ...nflverse.outcomes, espnNews.outcome, rotoBallerNews.outcome];
  const sourcesAttempted = outcomes.length;
  const sourcesSuccessful = outcomes.filter(item => item.status === 'SUCCESS').length;
  for (const outcome of outcomes) if (outcome.status !== 'SUCCESS' || outcome.stale) warnings.push(`${outcome.name}: ${outcome.stale ? 'STALE CACHE' : outcome.status}${outcome.detail ? ` — ${outcome.detail}` : ''}`);

  const supportingContext = buildSupportingContext(state.season, targetWeek, nflverse.games, nflverse.depthCharts, nflverse.injuries, nflverse.weeklyStats, nflverse.snapCounts as unknown as Array<Record<string, string>>);
  supportingContext.sleeperByGsis = new Map();
  for (const [sleeperId, player] of Object.entries(catalog.players)) {
    const gsis = identityResult.bySleeperId.get(sleeperId)?.gsisId || player.gsis_id;
    if (gsis) supportingContext.sleeperByGsis.set(gsis, player);
  }
  const injuryOutcome = nflverse.outcomes.find(outcome => outcome.name === 'nflverse injuries');
  const availabilityContext: AvailabilityContext = { now: new Date(), sleeperRetrievedAt: catalog.retrievedAt, sleeperStale: catalog.stale, officialRetrievedAt: injuryOutcome?.retrievedAt || null, officialStale: Boolean(injuryOutcome?.stale) };
  const evaluate = (id: string, status: PlayerEvaluation['rosterStatus'], ownedBy: number | null) =>
    makeEvaluation(id, catalog.players[id], espnResult.data.get(id), status, ownedBy, identityResult.bySleeperId.get(id), supportingContext, newsBySleeperId.get(id) || [], availabilityContext);

  progress({ stage: 'evaluation', message: `Evaluating ${freeIds.length.toLocaleString()} available free agents…`, current: 0, total: freeIds.length });
  const myPlayers = (myRoster.players || []).map(id => evaluate(id, rosterStatus(id, myRoster), ownership.get(id) ?? myRoster.roster_id));
  const freeAgents = freeIds.map(id => evaluate(id, 'free_agent', null))
    .sort((a, b) => (b.weeklyPoints ?? -Infinity) - (a.weeklyPoints ?? -Infinity) || a.name.localeCompare(b.name)).slice(0, 500);
  const replacementLevels = calculateReplacementLevels(freeAgents, league.roster_positions);
  applyReplacementValues([...myPlayers, ...freeAgents], replacementLevels);

  progress({ stage: 'opponent_lineup', message: 'Evaluating your opponent\'s current lineup…' });
  const opponentPlayers = opponentRoster ? opponentLineupIds.map(id => evaluate(id, 'starter', opponentRoster.roster_id)) : [];

  progress({ stage: 'lineup', message: 'Solving the legal maximum-value lineup assignment…' });
  const band = decisionBand(replacementLevels);
  const bonus = correlationBonusMap(myPlayers, opponentPlayers, band);
  const currentLineupPlayers = currentStarterIds.map(id => evaluate(id, 'starter', myRoster.roster_id));
  const currentSlots = starterSlots(league.roster_positions);
  const currentLineup = currentSlots.map((slot, index) => ({ slot, player: currentLineupPlayers[index] || null, changed: false, previousPlayerId: currentStarterIds[index] || null }));
  const recommendedLineup = optimizeLineup(myPlayers, league.roster_positions, currentStarterIds, bonus);
  const recommendedIds = new Set(recommendedLineup.flatMap(entry => entry.player ? [entry.player.playerId] : []));
  // A correlation tiebreak only counts as applied if removing it would have changed who starts.
  const withoutBonusIds = new Set(optimizeLineup(myPlayers, league.roster_positions, currentStarterIds).flatMap(entry => entry.player ? [entry.player.playerId] : []));
  const tiebrokenIds = new Set([...bonus.keys()].filter(id => recommendedIds.has(id) && !withoutBonusIds.has(id)));
  attachLineupDecisions(currentLineup, recommendedLineup, band, tiebrokenIds);
  for (const entry of recommendedLineup) {
    if (!entry.player || !entry.decision) continue;
    entry.player.reasons.unshift(entry.decision.headline);
    const benched = myPlayers.find(player => player.playerId === entry.decision!.benchId);
    if (benched) benched.reasons.unshift(`Not started: ${entry.decision.headline}`);
  }
  // Best lineup if everyone plays: published projections only, availability ignored (excluded players re-admitted).
  const pureProjectionLineup = optimizeIfEveryonePlays(myPlayers, league.roster_positions, currentStarterIds);
  const pureProjectionTotal = lineupTotal(pureProjectionLineup);
  const currentProjected = lineupTotal(currentLineup);
  const totalProjected = lineupTotal(recommendedLineup);
  const recommendedExpectedTotal = lineupExpectedTotal(recommendedLineup);
  const projectionSacrificeForAvailability = pureProjectionTotal != null && totalProjected != null ? Math.round((pureProjectionTotal - totalProjected) * 100) / 100 : null;
  const expectedWeeklyImprovement = currentProjected != null && totalProjected != null ? Math.round((totalProjected - currentProjected) * 100) / 100 : null;

  progress({ stage: 'transactions', message: 'Checking waiver status and simulating add/drop combinations…' });
  const transactionWeeks = [...new Set([state.week, targetWeek, targetWeek - 1].filter(week => week >= 1 && week <= 18))];
  let transactionsLoaded = true;
  const rawTransactions: unknown[] = [];
  for (const week of transactionWeeks) {
    try { rawTransactions.push(...await sleeperApi.getTransactions(config.leagueId, week)); }
    catch { transactionsLoaded = false; }
  }
  const waiverRules = inferWaiverRules({ leagueSettings: league.settings, rosterSettings: myRoster.settings, teams: rosters.length, transactionsLoaded });
  if (!transactionsLoaded) warnings.push('Sleeper league transactions could not be loaded, so waiver-versus-free-agent status is UNKNOWN and every add is priced as a waiver claim.');
  const recentDrops = recentDropsFromTransactions(rawTransactions);
  const acquisitionNow = new Date();
  for (const agent of freeAgents) {
    agent.acquisition = inferAcquisition({ team: agent.team, playerId: agent.playerId, now: acquisitionNow, sleeperWeek: state.week, season: state.season, games: nflverse.games, recentDrops, clearDays: waiverRules.clearDays, transactionsLoaded });
  }
  const searched = searchTransactions(myPlayers, freeAgents, league.roster_positions, currentStarterIds, { week: targetWeek, replacementLevels, waiverRules });
  const bench = myPlayers.filter(player => !recommendedIds.has(player.playerId) && player.rosterStatus !== 'reserve' && player.rosterStatus !== 'taxi');
  const reserve = myPlayers.filter(player => player.rosterStatus === 'reserve');
  const taxi = myPlayers.filter(player => player.rosterStatus === 'taxi');

  const kickedOff = recommendedLineup.filter(entry => entry.player?.availability?.gameStarted);
  if (kickedOff.length) warnings.push(`${kickedOff.length} of ${recommendedLineup.length} recommended starters' games for Week ${targetWeek} have already kicked off (${kickedOff.map(entry => entry.player!.name).join(', ')}). Sleeper locks those slots; injury designations issued after a game mostly affect next week.`);

  progress({ stage: 'matchup', message: 'Analyzing opponent correlation…' });
  let matchupAnalysis: MatchupAnalysis | null = null;
  if (opponentRoster) {
    const opponentOwner = users.find(user => user.user_id === opponentRoster.owner_id);
    const opponentSlots = starterSlots(league.roster_positions);
    const opponentLineup = opponentSlots.map((slot, index) => ({ slot, player: opponentPlayers[index] || null, changed: false, previousPlayerId: opponentLineupIds[index] || null }));
    const opponentProjected = lineupTotal(opponentLineup);
    const correlations: CorrelationNote[] = buildCorrelationNotes(recommendedLineup, opponentLineup, tiebrokenIds);
    matchupAnalysis = {
      opponentRosterId: opponentRoster.roster_id, opponentName: opponentOwner?.metadata?.team_name || opponentOwner?.display_name || `Roster ${opponentRoster.roster_id}`,
      myProjected: totalProjected, opponentProjected, difference: totalProjected != null && opponentProjected != null ? Math.round((totalProjected - opponentProjected) * 100) / 100 : null,
      myLineup: recommendedLineup.map(matchupLine), opponentLineup: opponentLineup.map(matchupLine), correlations
    };
  } else warnings.push(weekSelection.matchupNote || `No Week ${targetWeek} opponent was found (bye week, playoffs, or an incomplete matchup schedule).`);

  progress({ stage: 'league_context', message: 'Calculating league-wide roster context…' });
  const leagueTeams: LeagueTeamView[] = rosters.map(roster => {
    const owner = users.find(user => user.user_id === roster.owner_id);
    const all = (roster.players || []).map(id => evaluate(id, rosterStatus(id, roster), roster.roster_id));
    const lineup = optimizeLineup(all, league.roster_positions, roster.starters || []);
    const projected = lineupTotal(lineup);
    return {
      rosterId: roster.roster_id, owner: owner?.display_name || owner?.username || 'Unassigned', teamName: owner?.metadata?.team_name || owner?.display_name || `Roster ${roster.roster_id}`,
      starters: all.filter(player => roster.starters?.includes(player.playerId)),
      bench: all.filter(player => !roster.starters?.includes(player.playerId) && !roster.reserve?.includes(player.playerId) && !roster.taxi?.includes(player.playerId)),
      reserve: all.filter(player => roster.reserve?.includes(player.playerId)), taxi: all.filter(player => roster.taxi?.includes(player.playerId)),
      projectedPoints: projected, strengths: [], weaknesses: []
    };
  });

  const mapping = mappingDiagnostics(identityResult.diagnostics, relevantIdSet);
  const sleeperCache = getSleeperCacheInfo();
  const dataThroughAt = outcomes.reduce<string | null>((latest, outcome) => !outcome.retrievedAt ? latest : (!latest || outcome.retrievedAt > latest ? outcome.retrievedAt : latest), null);
  const diagnostics: AnalysisDiagnostics = {
    sleeperStatus: 'Connected', season: state.season, week: targetWeek, sleeperWeek: state.week,
    sleeperPlayersCached: sleeperCache.count, sourcesAttempted, sourcesSuccessful, sourcesStale: outcomes.filter(item => item.stale).length, sources: outcomes.map(toDiagnosticStatus),
    mapped: mapping.counts.mapped, unmapped: mapping.counts.unmapped, ambiguous: mapping.counts.ambiguous,
    projectionCoverage: freeAgents.length ? Math.round(freeAgents.reduce((sum, p) => sum + (p.projectionCoverage || 0), 0) / freeAgents.length) : 0,
    unsupportedScoringKeys: [...new Set(myPlayers.flatMap(p => p.unsupportedScoringKeys || []))],
    lastSleeperRefresh: sleeperCache.fetchedAt, mappings: mapping.items
  };
  const result: AnalysisResult = {
    id: randomUUID(), analyzedAt: new Date().toISOString(), analysisStartedAt, dataThroughAt,
    week: targetWeek, weekSelection, season: state.season,
    league: { league_id: league.league_id, name: league.name, roster_positions: league.roster_positions, scoring_settings: league.scoring_settings },
    provider: `${sourcesSuccessful}/${sourcesAttempted} free data sources succeeded`, limitedMode: sourcesSuccessful === 0,
    warnings, currentLineup, recommendedLineup, bench, reserve, taxi, freeAgents,
    transactions: searched.transactions, transactionSummary: searched.summary, consideredTransactions: searched.considered, leagueTeams, replacementLevels, diagnostics, matchupAnalysis,
    rosterAnalysis: {
      totalProjected, currentProjected, expectedWeeklyImprovement, projectionCoverage: diagnostics.projectionCoverage,
      pureProjectionLineup, pureProjectionTotal, recommendedProjectionTotal: totalProjected, projectionSacrificeForAvailability, recommendedExpectedTotal,
      positions: positionCounts(myPlayers),
      summary: totalProjected == null ? 'Projection coverage is incomplete. Unknown values were preserved rather than treated as zero.' : `Best available-player lineup projects ${totalProjected.toFixed(1)} published points${projectionSacrificeForAvailability != null && projectionSacrificeForAvailability > 0.005 ? `; if every rostered player played, the best lineup would project ${pureProjectionTotal!.toFixed(1)} — ${projectionSacrificeForAvailability.toFixed(1)} points are given up for availability` : ''}. ${expectedWeeklyImprovement == null ? 'Current-lineup coverage is incomplete.' : `${expectedWeeklyImprovement >= 0 ? '+' : ''}${expectedWeeklyImprovement.toFixed(1)} versus the current lineup.`}`
    },
    provenance: {
      roster: 'Sleeper public API', leagueRules: 'Sleeper public API',
      projection: 'ESPN weekly stat projections rescored for this Sleeper league',
      rankings: 'ESPN expert-panel ranks',
      injury: 'nflverse official weekly injury report + Sleeper injury status (re-fetched every run), ESPN/RotoBaller news for corroboration',
      schedule: 'nflverse schedules', news: 'ESPN NFL News + RotoBaller', mappings: 'DynastyProcess crosswalk with persisted fallback matches'
    }
  };
  progress({ stage: 'complete', message: 'Analysis complete.', done: true, result });
  return result;
}
