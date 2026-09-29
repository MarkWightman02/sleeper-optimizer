import type { DataConfidence, MappingConfidence, NormalizedInjuryStatus, PlayerEvaluation, ProjectionValue, RankingValue } from '../../shared/types.js';

export interface Consensus { points: number | null; coverage: number }

/** Transparent, unweighted average of every published numeric projection. Every individual value is retained on the player (`projections`); this only produces the single headline number. */
export function combineProjections(values: ProjectionValue[]): Consensus {
  if (!values.length) return { points: null, coverage: 0 };
  const points = Math.round((values.reduce((sum, value) => sum + value.points, 0) / values.length) * 100) / 100;
  const coverage = Math.round(values.reduce((sum, value) => sum + (value.coverage ?? 0), 0) / values.length);
  return { points, coverage };
}

export type ConfidenceLevel = PlayerEvaluation['confidence'];

export interface ConfidenceInputs {
  projections: Array<Pick<ProjectionValue, 'points' | 'coverage' | 'stale'>>;
  rankings: Array<Pick<RankingValue, 'expertCount' | 'rankMin' | 'rankMax' | 'positionRank' | 'stale'>>;
  /** Positional rank implied by this league's rescored projection among all projected players at the position, when known. */
  projectionPositionRank?: number | null;
  mappingConfidence: MappingConfidence;
  normalizedInjuryStatus: NormalizedInjuryStatus;
  /** How sure we are about the availability picture itself (not how severe it is). */
  availabilityConfidence?: 'High' | 'Medium' | 'Low';
  newsConflict?: boolean;
}

export interface ConfidenceResult { level: ConfidenceLevel; score: number; reasons: string[] }

const LEVEL_ORDER: Record<ConfidenceLevel, number> = { Unavailable: 0, Low: 1, Medium: 2, High: 3 };
const lower = (a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel => LEVEL_ORDER[a] <= LEVEL_ORDER[b] ? a : b;

/** True when the expert panel's positional ranks are tightly clustered (≥3 experts, spread within max(6, half the median)). */
export function rankingsAgree(ranking: Pick<RankingValue, 'expertCount' | 'rankMin' | 'rankMax' | 'positionRank'>): boolean | null {
  if (!ranking.expertCount || ranking.expertCount < 3 || ranking.rankMin == null || ranking.rankMax == null || ranking.positionRank == null) return null;
  return ranking.rankMax - ranking.rankMin <= Math.max(6, ranking.positionRank * 0.5);
}

/**
 * DATA-QUALITY confidence (how far the underlying data can be trusted — never how good the player is).
 * Score = projection source count + scoring coverage + expert-ranking agreement + projection-vs-ranking agreement
 *         + identity mapping − availability uncertainty. Then hard caps:
 *   stale or missing-coverage projection → Low; medium/low mapping, availability uncertainty, or a news conflict → at most Medium.
 * A single numeric source can only reach High when it is fresh, well covered, exactly mapped, and independently corroborated
 * by tightly clustered expert ranks that agree with the projection — otherwise it tops out at Medium.
 * High ≥ 4, Medium ≥ 1, else Low.
 */
export function computeConfidence(inputs: ConfidenceInputs): ConfidenceResult {
  const { projections, rankings, mappingConfidence, normalizedInjuryStatus } = inputs;
  const reasons: string[] = [];
  if (!projections.length) {
    reasons.push('No source published a projection for this player this week.');
    return { level: rankings.length ? 'Low' : 'Unavailable', score: 0, reasons };
  }
  let score = 0;
  let cap: ConfidenceLevel = 'High';
  const capAt = (level: ConfidenceLevel) => { cap = lower(cap, level); };

  if (projections.length >= 2) {
    score += 2;
    const values = projections.map(p => p.points);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const spread = Math.max(...values) - Math.min(...values);
    const relative = mean > 0 ? spread / mean : spread;
    if (relative <= 0.15) { score += 1; reasons.push(`${projections.length} projection sources agree within ${Math.round(relative * 100)}%.`); }
    else if (relative >= 0.4) { score -= 2; capAt('Medium'); reasons.push(`Projection sources disagree widely (${Math.round(relative * 100)}% spread).`); }
    else reasons.push(`${projections.length} projection sources with a moderate ${Math.round(relative * 100)}% spread.`);
  } else {
    score += 1;
    reasons.push('Only one numeric projection source (ESPN); no second projection to cross-check.');
  }

  if (projections.some(p => p.stale)) {
    score -= 3; capAt('Low');
    reasons.push('A projection came from an older cached copy because the live fetch failed (stale).');
  }
  const coverage = Math.round(projections.reduce((sum, p) => sum + (p.coverage ?? 0), 0) / projections.length);
  if (coverage >= 85) { score += 1; reasons.push(`Scoring coverage ${coverage}%: the source's statistics express nearly every scoring rule of this league.`); }
  else if (coverage < 50) { score -= 2; capAt('Low'); reasons.push(`Low scoring coverage (${coverage}%): many of this league's scoring rules cannot be expressed from the source.`); }
  else { capAt('Medium'); reasons.push(`Partial scoring coverage (${coverage}%).`); }

  const ranking = rankings[0];
  const agree = ranking ? rankingsAgree(ranking) : null;
  if (!ranking) reasons.push('No expert ranking is published for this player, so the projection is not corroborated.');
  else if (agree === true) { score += 1; reasons.push(`${ranking.expertCount} expert rankings are tightly clustered (#${ranking.rankMin}–#${ranking.rankMax}).`); }
  else if (agree === false) { score -= 1; capAt('Medium'); reasons.push(`Expert rankings disagree (#${ranking.rankMin}–#${ranking.rankMax}).`); }
  else reasons.push('Too few expert rankings to judge agreement.');
  if (ranking?.stale) { score -= 1; capAt('Medium'); reasons.push('Expert rankings came from an older cached copy.'); }

  if (ranking && inputs.projectionPositionRank != null && ranking.positionRank != null && agree !== null) {
    const gap = Math.abs(inputs.projectionPositionRank - ranking.positionRank);
    if (gap <= Math.max(4, ranking.positionRank * 0.4)) { score += 1; reasons.push(`This league's projection ranks the player #${inputs.projectionPositionRank} at the position, consistent with the experts' #${ranking.positionRank}.`); }
    else { score -= 1; capAt('Medium'); reasons.push(`This league's projection ranks the player #${inputs.projectionPositionRank} but experts have #${ranking.positionRank}.`); }
  }

  if (mappingConfidence === 'exact' || mappingConfidence === 'high') { score += 1; reasons.push(`Player identity mapping is ${mappingConfidence}.`); }
  else if (mappingConfidence === 'medium' || mappingConfidence === 'low') { capAt('Medium'); score -= 1; reasons.push(`Player identity rests on a ${mappingConfidence}-confidence name match.`); }
  else { capAt('Low'); score -= 3; reasons.push(`Player identity is ${mappingConfidence}; projection may belong to a different player.`); }

  if (normalizedInjuryStatus === 'QUESTIONABLE' || normalizedInjuryStatus === 'UNKNOWN') { score -= 1; capAt('Medium'); reasons.push(`Availability is uncertain (${normalizedInjuryStatus}).`); }
  else if (normalizedInjuryStatus === 'DOUBTFUL') { score -= 2; capAt('Medium'); reasons.push('Availability is doubtful.'); }
  if (inputs.availabilityConfidence === 'Low') { score -= 2; capAt('Medium'); reasons.push('Injury sources are stale or conflict.'); }
  else if (inputs.availabilityConfidence === 'Medium' && normalizedInjuryStatus !== 'ACTIVE') { score -= 1; reasons.push('Injury status rests on a single unofficial source.'); }
  if (inputs.newsConflict) { score -= 2; capAt('Medium'); reasons.push('Recent news conflicts with the listed status.'); }

  const base: ConfidenceLevel = score >= 4 ? 'High' : score >= 1 ? 'Medium' : 'Low';
  return { level: lower(base, cap), score, reasons };
}

export interface DataConfidenceInput {
  outcomes: Array<{ name: string; kind: string; status: string; stale?: boolean }>;
  /** The lineup the user will act on (recommended starters). */
  starters: Array<Pick<PlayerEvaluation, 'confidence' | 'weeklyPoints' | 'name'>>;
}

/**
 * Overall DATA confidence for the run: fresh critical sources first, then the quality of the data behind the starters.
 * It never looks at how good the players are. Critical sources (ESPN projections, Sleeper catalog, injury report) failing or
 * being stale cap the run at Low/Medium regardless of everything else.
 */
export function computeDataConfidence(input: DataConfidenceInput): DataConfidence {
  const { outcomes, starters } = input;
  const reasons: string[] = [];
  const successful = outcomes.filter(item => item.status === 'SUCCESS').length;
  const stale = outcomes.filter(item => item.stale).length;
  let level: DataConfidence['level'] = 'High';
  const cap = (next: DataConfidence['level']) => { level = next === 'Low' || level === 'Low' ? 'Low' : next === 'Medium' || level === 'Medium' ? 'Medium' : 'High'; };

  const projection = outcomes.find(item => item.kind === 'projection');
  if (!projection || projection.status !== 'SUCCESS') { cap('Low'); reasons.push('The projection source failed, so no fresh projections exist.'); }
  else if (projection.stale) { cap('Low'); reasons.push('Projections are an older cached copy (the live fetch failed).'); }
  const injuries = outcomes.filter(item => item.kind === 'injury');
  if (injuries.some(item => item.status !== 'SUCCESS')) { cap('Medium'); reasons.push('An injury source failed; availability relies on the remaining source.'); }
  else if (injuries.some(item => item.stale)) { cap('Medium'); reasons.push('An injury source is an older cached copy.'); }
  const failed = outcomes.length - successful;
  if (outcomes.length && successful / outcomes.length < 0.5) { cap('Low'); reasons.push(`Only ${successful} of ${outcomes.length} sources succeeded.`); }
  else if (failed > 0) { cap('Medium'); reasons.push(`${failed} of ${outcomes.length} sources failed (${outcomes.filter(item => item.status !== 'SUCCESS').map(item => item.name).join(', ')}).`); }
  if (stale > 0 && !reasons.some(reason => reason.includes('older cached'))) { cap('Medium'); reasons.push(`${stale} source${stale === 1 ? ' is' : 's are'} served from an older cache.`); }

  const weak = starters.filter(starter => starter.confidence === 'Low' || starter.confidence === 'Unavailable');
  const high = starters.filter(starter => starter.confidence === 'High').length;
  if (starters.length) {
    if (weak.length > Math.max(1, starters.length / 4)) { cap('Low'); reasons.push(`${weak.length} of ${starters.length} recommended starters rest on weak data (${weak.map(item => item.name).join(', ')}).`); }
    else if (weak.length) { cap('Medium'); reasons.push(`${weak.length} recommended starter${weak.length === 1 ? '' : 's'} rest${weak.length === 1 ? 's' : ''} on weak data (${weak.map(item => item.name).join(', ')}).`); }
    if (high / starters.length < 0.5) { cap('Medium'); reasons.push(`Only ${high} of ${starters.length} recommended starters have High player-level data confidence.`); }
    else reasons.push(`${high} of ${starters.length} recommended starters have High player-level data confidence.`);
  }
  if (level === 'High') reasons.unshift(`All ${successful} of ${outcomes.length} sources succeeded with fresh data.`);
  return { level, reasons, sourcesSuccessful: successful, sourcesAttempted: outcomes.length, sourcesStale: stale };
}
