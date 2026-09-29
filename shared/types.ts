export type JsonRecord = Record<string, unknown>;

export interface SleeperState {
  week: number;
  season: string;
  season_type: string;
  display_week?: number;
}

export interface SleeperUser {
  user_id: string;
  username: string;
  display_name: string;
  avatar?: string | null;
  metadata?: Record<string, string>;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: Record<string, number>;
  settings: Record<string, number>;
  avatar?: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve: string[] | null;
  taxi: string[] | null;
  settings?: Record<string, number>;
  metadata?: Record<string, string>;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  players: string[];
  starters: string[];
  points?: number;
}

export interface SleeperPlayer {
  player_id: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  team?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  status?: string | null;
  injury_status?: string | null;
  active?: boolean;
  age?: number | null;
  years_exp?: number | null;
  fantasy_data_id?: number | null;
  sportradar_id?: string | null;
  gsis_id?: string | null;
  espn_id?: number | null;
  yahoo_id?: number | null;
  rotowire_id?: number | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  injury_start_date?: string | null;
  practice_participation?: string | null;
  practice_description?: string | null;
  news_updated?: number | null;
}

export interface AppConfig {
  username: string;
  userId: string;
  leagueId: string;
  leagueName: string;
  season: string;
}

export interface ProviderMetric {
  value: number | string | null;
  source: string;
}

export type NormalizedInjuryStatus = 'ACTIVE' | 'QUESTIONABLE' | 'DOUBTFUL' | 'OUT' | 'IR' | 'PUP' | 'SUSPENDED' | 'UNKNOWN';
export type MappingConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unmapped' | 'ambiguous';
export type RecommendationTier = 'STRONG CLAIM' | 'CLAIM' | 'OPTIONAL' | 'SPECULATIVE' | 'HOLD' | 'AVOID';
export type AcquisitionKind = 'WAIVER_CLAIM' | 'FREE_AGENT' | 'UNKNOWN';
export type RoleKind = 'DURABLE' | 'MODERATE' | 'TEMPORARY_FILL_IN' | 'LIMITED' | 'UNKNOWN';

/** How a free agent would be acquired. Sleeper exposes no per-player flag, so this is inferred (see server/engine/waiver.ts). */
export interface Acquisition { kind: AcquisitionKind; reason: string; clearsAt?: string | null }

/** Descriptive role/usage context. Supporting evidence only; it is never converted into a projection. */
export interface RoleEvidence {
  kind: RoleKind;
  depthRank: number | null;
  snapPct: number | null;
  recentUsage: string | null;
  injuriesAhead: Array<{ name: string; status: string }>;
  summary: string;
}

export interface WaiverRules {
  type: 'ROLLING' | 'REVERSE_STANDINGS' | 'FAAB' | 'UNKNOWN';
  clearDays: number | null;
  priorityPosition: number | null;
  teams: number;
  transactionsLoaded: boolean;
  notes: string[];
}

export interface TransactionSection { label: string; text: string }

export interface TransactionAssessment {
  weekly: { gain: number; confidenceFactor: number; persistenceFactor: number; adjustedGain: number };
  longTerm: { status: 'AVAILABLE' | 'INSUFFICIENT'; rosGainPerWeek: number | null; credit: number | null; note: string };
  drop: { cost: number; startingCaliberValue: number; roleValue: number; depthLoss: number; notes: string[] };
  need: { credit: number; notes: string[] };
  waiver: { acquisition: AcquisitionKind; cost: number; priorityPosition: number | null; teams: number | null; note: string };
  net: number;
  required: { optional: number; claim: number; strong: number; adjustments: string[] };
  breakEvenWeeklyGain: number;
  sections: TransactionSection[];
}

export interface TransactionSummary {
  decision: 'HOLD' | 'MOVE';
  headline: string;
  waiverRules: WaiverRules | null;
  bestConsidered: { add: string; drop: string; tier: RecommendationTier; net: number; weeklyGain: number | null } | null;
  why: string;
}

export interface ScoringComponent {
  providerStat: string;
  projectedStat: number | null;
  sleeperKey: string | null;
  multiplier: number | null;
  projectedPoints: number | null;
  modeled: boolean;
  note?: string;
}

/** A numeric fantasy-point forecast actually published by one external source. Never fabricated. */
export interface ProjectionValue {
  source: string;
  points: number;
  scoringComponents?: ScoringComponent[];
  unsupportedScoringKeys?: string[];
  coverage?: number;
  retrievedAt: string | null;
}

/** A published ordinal rank from one external source. Never converted into points. */
export interface RankingValue {
  source: string;
  positionRank: number | null;
  overallRank: number | null;
  scoringType?: string | null;
  retrievedAt: string | null;
}

/** Short, factual, attributed news context. Never a full copied article. */
export interface NewsItem {
  source: string;
  headline: string;
  summary: string | null;
  url: string | null;
  publishedAt: string | null;
}

/** Descriptive supporting evidence (snaps, depth chart, recent actual stats). Never a projection. */
export interface SupportingDataPoint {
  label: string;
  value: string;
  source: string;
}

export type RiskFlag = 'NONE' | 'WATCH' | 'AVOID' | 'EXCLUDED';
export type NewsSignal = 'negative' | 'positive' | 'neutral';

/**
 * Availability is kept strictly separate from the published projection. `playProbability` is a documented,
 * deterministic policy value (see server/engine/availability.ts) — it is NOT a projection and never rewrites one.
 */
export interface AvailabilityAssessment {
  status: NormalizedInjuryStatus;
  rawStatus: string | null;
  injury: string | null;
  practice: string | null;
  practiceLevel: 'full' | 'limited' | 'dnp' | null;
  statusSource: string;
  statusUpdatedAt: string | null;
  retrievedAt: string | null;
  sourceStale: boolean;
  latestNews: (NewsItem & { signal: NewsSignal }) | null;
  newsSignal: NewsSignal;
  playProbability: number;
  riskFlag: RiskFlag;
  confidence: 'High' | 'Medium' | 'Low';
  confidenceReasons: string[];
  gameStarted: boolean;
  policy: string;
}

export interface PlayerEvaluation {
  playerId: string;
  espnId?: string | null;
  name: string;
  team: string | null;
  positions: string[];
  status: string | null;
  injuryStatus: string | null;
  normalizedInjuryStatus?: NormalizedInjuryStatus;
  injuryBodyPart?: string | null;
  practiceParticipation?: string | null;
  injuryLastUpdated?: string | null;
  probabilityOfPlaying?: number | null;
  opponent: string | null;
  gameTime: string | null;
  /** Consensus weekly projection (transparent combination of `projections`). Null when no source projected this player. */
  weeklyPoints: number | null;
  /** Availability assessment (separate from `weeklyPoints`). */
  availability?: AvailabilityAssessment;
  /** weeklyPoints × availability.playProbability — the lineup solver's objective. Never shown as a projection. */
  expectedPoints?: number | null;
  restOfSeasonValue: number | null;
  confidence: 'High' | 'Medium' | 'Low' | 'Unavailable';
  rosterStatus: 'starter' | 'bench' | 'reserve' | 'taxi' | 'free_agent' | 'owned';
  eligible: boolean;
  ownedBy?: number | null;
  isFreeAgent?: boolean;
  projectionCoverage?: number;
  mappingConfidence?: MappingConfidence;
  mappingMethod?: string | null;
  valueOverReplacement?: number | null;
  scarcityValue?: number | null;
  recommendationTier?: RecommendationTier;
  role?: RoleEvidence;
  acquisition?: Acquisition;
  scoringComponents?: ScoringComponent[];
  unsupportedScoringKeys?: string[];
  projections: ProjectionValue[];
  rankings: RankingValue[];
  newsItems: NewsItem[];
  supportingData: SupportingDataPoint[];
  metrics: Record<string, ProviderMetric>;
  reasons: string[];
}

export type LineupDecisionKind = 'PROJECTION' | 'CLOSE_CALL' | 'TOSS_UP' | 'AVAILABILITY_EXCLUSION' | 'AVAILABILITY_DISCOUNT' | 'NO_PROJECTION';

export interface LineupDecision {
  kind: LineupDecisionKind;
  headline: string;
  startId: string;
  startName: string;
  benchId: string;
  benchName: string;
  startProjection: number | null;
  benchProjection: number | null;
  /** start − bench, in published projection points. Negative means the started player projects LOWER. */
  difference: number | null;
  /** Projection points given up (bench − start) when kind is an availability override; otherwise null. */
  projectionSacrifice: number | null;
  startExpected: number | null;
  benchExpected: number | null;
  benchAvailability: AvailabilityAssessment | null;
  whyLowerProjection: string | null;
  decisionLogic: string[];
  whatCouldChange: string[];
  correlationTiebreak: boolean;
}

export interface LineupEntry {
  slot: string;
  player: PlayerEvaluation | null;
  changed: boolean;
  previousPlayerId: string | null;
  decision?: LineupDecision;
}

export interface TransactionRecommendation {
  add: PlayerEvaluation;
  drop: PlayerEvaluation;
  weeklyGain: number | null;
  restOfSeasonGain: number | null;
  confidence: 'High' | 'Medium' | 'Low';
  tier?: RecommendationTier;
  acquisition?: AcquisitionKind;
  assessment?: TransactionAssessment;
  score?: number;
  recommended?: boolean;
  components?: {
    weeklyLineupGain: number;
    rosPerWeekGain: number | null;
    replacementAdjustedGain: number | null;
    dropOpportunityCost: number;
    injuryRiskPenalty: number;
  };
  resultingLineup?: LineupEntry[];
  reasons: string[];
}

export interface ReplacementLevel {
  position: string;
  bestAvailable: number | null;
  medianAvailable: number | null;
  replacementLevel: number | null;
  rosReplacementLevel: number | null;
  starterDemandPerTeam: number;
  dropOffCurve: number[];
}

export interface MappingDiagnostic {
  sleeperPlayerId?: string | null;
  externalPlayerId?: string | null;
  name: string;
  team: string | null;
  position: string | null;
  status: 'mapped' | 'unmapped' | 'ambiguous';
  method: string | null;
  confidence: MappingConfidence;
  candidates?: string[];
}

export type SourceKind = 'projection' | 'ranking' | 'injury' | 'news' | 'schedule' | 'supporting' | 'identity';
export type SourceStatusValue = 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PARSE_ERROR' | 'BLOCKED';

export interface SourceStatus {
  name: string;
  kind: SourceKind;
  status: SourceStatusValue;
  detail?: string;
  retrievedAt: string | null;
  /** True when this run could not refresh the source and fell back to an older cached copy. */
  stale?: boolean;
}

export interface AnalysisDiagnostics {
  sleeperStatus: 'Connected' | 'Error';
  season: string;
  week: number;
  sleeperWeek?: number;
  sleeperPlayersCached: number;
  sourcesAttempted: number;
  sourcesSuccessful: number;
  sourcesStale?: number;
  sources: SourceStatus[];
  mapped: number;
  unmapped: number;
  ambiguous: number;
  projectionCoverage: number;
  unsupportedScoringKeys: string[];
  lastSleeperRefresh: string | null;
  mappings: MappingDiagnostic[];
  lastOptimizationDurationMs?: number;
}

export interface LeagueTeamView {
  rosterId: number;
  owner: string;
  teamName: string;
  starters: PlayerEvaluation[];
  bench: PlayerEvaluation[];
  reserve: PlayerEvaluation[];
  taxi: PlayerEvaluation[];
  projectedPoints: number | null;
  strengths: string[];
  weaknesses: string[];
}

export interface CorrelationNote {
  myPlayerId: string;
  myPlayerName: string;
  opponentPlayerId: string;
  opponentPlayerName: string;
  team: string;
  relationship: string;
  explanation: string;
  appliedAsTiebreak: boolean;
}

export interface MatchupTeamLine {
  slot: string;
  playerId: string | null;
  name: string;
  positions: string[];
  team: string | null;
  opponent: string | null;
  weeklyPoints: number | null;
  status: string | null;
  confidence: PlayerEvaluation['confidence'];
}

export interface MatchupAnalysis {
  opponentRosterId: number | null;
  opponentName: string;
  myProjected: number | null;
  opponentProjected: number | null;
  difference: number | null;
  myLineup: MatchupTeamLine[];
  opponentLineup: MatchupTeamLine[];
  correlations: CorrelationNote[];
}

export interface WeekSelection {
  sleeperWeek: number;
  targetWeek: number;
  advanced: boolean;
  reason: string;
  message: string | null;
  relevantGames: { total: number; notKickedOff: number; kickedOff: number; bye: number; nextKickoff: string | null };
  matchupAvailable: boolean;
  matchupNote: string | null;
}

export interface AnalysisResult {
  weekSelection?: WeekSelection;
  id: string;
  analyzedAt: string;
  analysisStartedAt: string;
  dataThroughAt: string | null;
  week: number;
  season: string;
  league: Pick<SleeperLeague, 'league_id' | 'name' | 'roster_positions' | 'scoring_settings'>;
  provider: string | null;
  limitedMode: boolean;
  warnings: string[];
  currentLineup: LineupEntry[];
  recommendedLineup: LineupEntry[];
  bench: PlayerEvaluation[];
  reserve: PlayerEvaluation[];
  taxi: PlayerEvaluation[];
  freeAgents: PlayerEvaluation[];
  transactions: TransactionRecommendation[];
  transactionSummary?: TransactionSummary;
  consideredTransactions?: TransactionRecommendation[];
  leagueTeams: LeagueTeamView[];
  replacementLevels?: Record<string, ReplacementLevel>;
  diagnostics?: AnalysisDiagnostics;
  matchupAnalysis?: MatchupAnalysis | null;
  rosterAnalysis: {
    totalProjected: number | null;
    currentProjected?: number | null;
    expectedWeeklyImprovement?: number | null;
    projectionCoverage?: number;
    /** Best lineup if every rostered player plays (published projections only, availability ignored). */
    pureProjectionLineup?: LineupEntry[];
    pureProjectionTotal?: number | null;
    /** Sum of published projections of the recommended (availability-aware) lineup. */
    recommendedProjectionTotal?: number | null;
    /** pureProjectionTotal − recommendedProjectionTotal: projection given up for availability reasons. */
    projectionSacrificeForAvailability?: number | null;
    /** Availability-weighted expected total of the recommended lineup (Σ projection × play probability). */
    recommendedExpectedTotal?: number | null;
    positions: Record<string, number>;
    summary: string;
  };
  provenance: Record<string, string>;
}

export interface AnalysisHistoryItem {
  id: string;
  analyzedAt: string;
  season: string;
  week: number;
  currentProjected: number | null;
  recommendedProjected: number | null;
  expectedImprovement: number | null;
  provider: string | null;
  coverage: number;
  transactionCount: number;
}

export interface ProgressEvent {
  stage: string;
  message: string;
  current?: number;
  total?: number;
  done?: boolean;
  error?: string;
  result?: AnalysisResult;
}
