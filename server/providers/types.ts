import type {
  MappingConfidence,
  MappingDiagnostic,
  NewsItem,
  NormalizedInjuryStatus,
  ProjectionValue,
  RankingValue,
  ScoringComponent,
  SleeperPlayer,
  SupportingDataPoint
} from '../../shared/types.js';

export interface ProviderContext {
  season: string;
  week: number;
  scoring: Record<string, number>;
  players: Record<string, SleeperPlayer>;
  rosterPositions: string[];
  forceRefresh?: boolean;
}

export interface ExternalPlayerData {
  sleeperId: string;
  externalPlayerId?: string | null;
  weeklyPoints: number | null;
  restOfSeasonValue: number | null;
  injuryStatus: string | null;
  opponent: string | null;
  gameTime: string | null;
  confidence: 'High' | 'Medium' | 'Low';
  mappingConfidence?: MappingConfidence;
  mappingMethod?: string | null;
  projectionCoverage?: number;
  normalizedInjuryStatus?: NormalizedInjuryStatus;
  injuryBodyPart?: string | null;
  practiceParticipation?: string | null;
  injuryLastUpdated?: string | null;
  probabilityOfPlaying?: number | null;
  scoringComponents?: ScoringComponent[];
  unsupportedScoringKeys?: string[];
  rawWeeklyStats?: Record<string, number | null | undefined>;
  projections?: ProjectionValue[];
  rankings?: RankingValue[];
  newsItems?: NewsItem[];
  supportingData?: SupportingDataPoint[];
  metrics: Record<string, { value: number | string | null; source: string }>;
}

export interface ProviderLoadResult {
  data: Map<string, ExternalPlayerData>;
  status: 'Connected' | 'Error';
  error?: string;
  diagnostics: MappingDiagnostic[];
  projectionCount: number;
  coverage: number;
  unsupportedScoringKeys: string[];
  retrievedAt: string | null;
}

export interface ProjectionProvider {
  readonly name: string;
  isConfigured(): boolean;
  getWeeklyProjections(context: ProviderContext): Promise<Map<string, ExternalPlayerData>>;
}

export interface RankingProvider {
  readonly name: string;
  getRankings(context: ProviderContext): Promise<Map<string, RankingValue[]>>;
}

export interface InjuryProvider {
  readonly name: string;
  getInjuries(context: ProviderContext): Promise<Map<string, string>>;
}

export interface ScheduleProvider {
  readonly name: string;
  getSchedule(context: ProviderContext): Promise<Map<string, { opponent: string | null; gameTime: string | null }>>;
}

export interface PlayerNewsProvider {
  readonly name: string;
  getNews(context: ProviderContext): Promise<Map<string, NewsItem[]>>;
}

export interface SupportingDataProvider {
  readonly name: string;
  getSupportingData(context: ProviderContext): Promise<Map<string, SupportingDataPoint[]>>;
}

/** Per-source outcome for diagnostics. Every provider call reports one of these regardless of success/failure. */
export interface SourceOutcome {
  name: string;
  kind: 'projection' | 'ranking' | 'injury' | 'news' | 'schedule' | 'supporting' | 'identity';
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT' | 'PARSE_ERROR' | 'BLOCKED';
  detail?: string;
  retrievedAt: string | null;
  stale?: boolean;
}
