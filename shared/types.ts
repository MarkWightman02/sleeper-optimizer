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

/** Where a projection came from and the untouched provider numbers behind it, so any headline value can be reconciled. */
export interface ProjectionProvenance {
  season: number;
  week: number;
  /** ESPN stat entry descriptors: statSourceId 1 = projection (0 = actual), statSplitTypeId 1 = single scoring period. */
  statSourceId: number;
  statSplitTypeId: number;
  providerPlayerId: string;
  providerPlayerName: string | null;
  /** Raw provider stat line by stat id, exactly the values that fed the conversion. */
  rawStatLine: Record<string, number>;
  /** Scoring rules the provider could express but did not project for this player (contribute 0, do not lower coverage). */
  omittedKeys: string[];
  /** Minor scoring keys the provider has no projection for (ignored, listed for transparency). */
  minorUnmodeledKeys: string[];
  approximations: string[];
}

/** A numeric fantasy-point forecast actually published by one external source. Never fabricated. */
export interface ProjectionValue {
  source: string;
  points: number;
  scoringComponents?: ScoringComponent[];
  unsupportedScoringKeys?: string[];
  coverage?: number;
  retrievedAt: string | null;
  /** True when this value came from an older cached copy because the live fetch failed. */
  stale?: boolean;
  provenance?: ProjectionProvenance;
}

/** A published ordinal rank from one external source (or an aggregate of its expert panel). Never converted into points. */
export interface RankingValue {
  source: string;
  /** Median positional rank across the source's experts when several are published. */
  positionRank: number | null;
  overallRank: number | null;
  scoringType?: string | null;
  retrievedAt: string | null;
  week?: number;
  expertCount?: number;
  rankMin?: number | null;
  rankMax?: number | null;
  stale?: boolean;
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
export interface AvailabilityEvidence {
  source: string;
  kind: 'official-report' | 'sleeper-status' | 'news';
  /** What this source said (designation, practice status or headline). */
  detail: string;
  /** When the source itself published/updated it; null when the source exposes no timestamp. */
  publishedAt: string | null;
  retrievedAt: string | null;
  /** NFL week the evidence applies to; null when the source does not say. */
  targetWeek: number | null;
  /** Whether this evidence drove the availability decision (false = ignored, see `note`). */
  used: boolean;
  note?: string;
}

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
  /** Every injury-relevant source considered, with timestamps, target week and whether it was used. */
  evidence?: AvailabilityEvidence[];
  targetWeek?: number;
  /** Recent news contradicts the listed designation (or signals trouble with no designation at all). */
  newsConflict?: boolean;
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
  /** Data-quality reasons behind `confidence` (never about player quality). */
  confidenceReasons?: string[];
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

export type MappingMethodGroup = 'crosswalk_sleeper_id' | 'espn_id' | 'gsis_id' | 'name_team_position' | 'name_position' | 'persisted' | 'team_code' | 'ambiguous' | 'unmapped';

export interface MappingAudit {
  /** Players considered: rostered by any team plus the free-agent pool the app evaluates. */
  scope: string;
  total: number;
  byMethod: Record<MappingMethodGroup, number>;
  /** Mapped players whose identity rests on a fuzzy fallback (name-based) rather than an ID join. */
  fallbackCount: number;
  /** ESPN players with a real weekly projection that were not joined to any Sleeper player (missed mappings). */
  espnProjectedButUnmapped: Array<{ espnId: string; name: string; team: string | null; position: string; points: number }>;
  needsReview: Array<{ name: string; team: string | null; position: string | null; method: string | null; confidence: MappingConfidence; sleeperPlayerId: string | null }>;
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
  sourceUpdatedAt?: string | null;
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
  mappingAudit?: MappingAudit;
  dataConfidence?: DataConfidence;
}

export interface DataConfidence {
  level: 'High' | 'Medium' | 'Low';
  reasons: string[];
  sourcesSuccessful: number;
  sourcesAttempted: number;
  sourcesStale: number;
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

export type CorrelationKind =
  | 'CATCHER_VS_OPPONENT_QB' | 'QB_VS_OPPONENT_CATCHER'
  | 'MY_STACK' | 'OPPONENT_STACK'
  | 'MY_DEFENSE_VS_OPPONENT_OFFENSE' | 'OPPONENT_DEFENSE_VS_MY_OFFENSE'
  | 'MY_SHARED_QB' | 'OPPONENT_SHARED_QB';

export interface CorrelationPlayerRef {
  playerId: string;
  name: string;
  side: 'mine' | 'opponent';
  position: string;
  team: string | null;
  slot: string | null;
  projection: number | null;
}

export interface CorrelationNote {
  kind: CorrelationKind;
  title: string;
  team: string;
  players: CorrelationPlayerRef[];
  explanation: string;
  /** The projected scoring that actually overlaps (the numbers that made the relationship worth showing). */
  overlap: string;
  effect: 'DECISION_CHANGING' | 'INFORMATIONAL';
  effectNote: string;
  appliedAsTiebreak: boolean;
}

export interface TiebreakDecision {
  slot: string;
  chosenId: string;
  chosenName: string;
  alternativeId: string;
  alternativeName: string;
  chosenProjection: number | null;
  alternativeProjection: number | null;
  /** Alternative minus chosen expected points: what the tiebreak gave up (0 or negative means the chosen player also projected at least as high). */
  projectionGiven: number;
  band: number;
  posture: 'FAVORITE' | 'UNDERDOG';
  projectedMargin: number;
  correlatedWith: string;
  explanation: string;
}

export interface MatchupTeamLine {
  slot: string;
  playerId: string | null;
  name: string;
  positions: string[];
  team: string | null;
  /** NFL opponent this week. */
  opponent: string | null;
  weeklyPoints: number | null;
  expectedPoints: number | null;
  playProbability: number | null;
  status: string | null;
  statusDetail: string | null;
  confidence: PlayerEvaluation['confidence'];
}

export interface PositionEdge {
  group: string;
  mine: number | null;
  opponent: number | null;
  difference: number | null;
  myPlayers: string[];
  opponentPlayers: string[];
}

export interface UncertainStarter {
  side: 'mine' | 'opponent';
  playerId: string;
  name: string;
  slot: string;
  status: string;
  playProbability: number | null;
  weeklyPoints: number | null;
  detail: string;
}

export interface UncertaintyProfile {
  /** Σ published projection × (1 − chance of playing) across starters: points at risk from availability. */
  availabilityExposure: number;
  /** Starters whose data confidence is below High. */
  lowerConfidenceStarters: number;
  /** Starters with no usable projection at all. */
  unprojectedStarters: number;
}

export interface WaiverMatchupNote {
  add: string;
  drop: string;
  note: string;
}

export interface MatchupAnalysis {
  matchupId: number | null;
  opponentRosterId: number | null;
  opponentName: string;
  /** Availability-weighted totals (published projection × chance of playing) of the lineups shown below. */
  myProjected: number | null;
  opponentProjected: number | null;
  difference: number | null;
  totalBasis: string;
  myPublished: number | null;
  opponentPublished: number | null;
  incompleteStarters: { mine: string[]; opponent: string[] };
  myLineup: MatchupTeamLine[];
  opponentLineup: MatchupTeamLine[];
  positionEdges: PositionEdge[];
  largestAdvantages: PositionEdge[];
  largestDisadvantages: PositionEdge[];
  uncertainStarters: UncertainStarter[];
  uncertainty: { mine: UncertaintyProfile; opponent: UncertaintyProfile; moreUncertain: 'mine' | 'opponent' | 'even' | 'unclear'; explanation: string };
  correlations: CorrelationNote[];
  tiebreaks: TiebreakDecision[];
  waiverContext: WaiverMatchupNote[];
  winProbabilityNote: string;
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

/** Bump when the stored AnalysisResult shape changes incompatibly; older snapshots are then ignored instead of crashing the UI. */
export const ANALYSIS_SCHEMA_VERSION = 2;

export interface AnalysisResult {
  schemaVersion: number;
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
