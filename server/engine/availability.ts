import type { AvailabilityAssessment, NewsItem, NewsSignal, NormalizedInjuryStatus, RiskFlag, SleeperPlayer } from '../../shared/types.js';
import { BASE_PLAY_PROBABILITY, combineInjuryStatus, normalizeInjuryStatus, severity, type NflverseInjuryRow } from './injuries.js';

/**
 * AVAILABILITY POLICY (deterministic; keep in sync with ARCHITECTURE.md)
 *
 * Published projections are never edited. Availability is a separate `playProbability` used only as a multiplier in the
 * lineup solver's objective (expectedPoints = projection × playProbability), so the solver still maximizes expected points.
 *
 *   ACTIVE / no concern      1.00  normal projection-first optimization
 *   UNKNOWN                  0.90
 *   QUESTIONABLE             0.85  baseline — a bare "Questionable" label can only beat a much higher projection if
 *                                  the projection is enormous (a 0.15 haircut), so it never silently benches a 5+ point edge
 *        + full practice     0.95
 *        + limited practice  0.80
 *        + did-not-practice  0.50
 *        + negative news     ≤0.50  (explicit "week-to-week", "unlikely to play", "ruled out", …)
 *        + positive news     ≥0.95  ("expected to play", "cleared", "full participant", …)
 *   DOUBTFUL                 0.25  (0.40 with positive news) — strong penalty, avoided unless nobody comparable exists
 *   OUT / IR / PUP / SUSPENDED 0   excluded from the lineup entirely
 */

const NEGATIVE_NEWS = [
  /ruled out/i, /(?:will|won't|will not|would not) (?:play|suit up)/i, /unlikely to (?:play|suit up|return)/i, /week[- ]to[- ]week/i,
  /(?:expected|likely|set) to miss/i, /will miss/i, /out for (?:the )?(?:season|year|\d+|several|multiple|next|at least)/i,
  /placed on (?:injured reserve|IR)/i, /(?:suffered|sustained|exited with|left with)\s+(?:an?\s+)?[\w-]+(?:\s[\w-]+)?\s+(?:injury|strain|sprain|tear)/i, /doubtful/i
];
const POSITIVE_NEWS = [
  /expected to play/i, /(?:will|should) play/i, /cleared (?:to play|for)/i, /full(?:y)? (?:participant|participation)/i,
  /practiced fully/i, /full practice/i, /good to go/i, /no (?:setbacks|restrictions)/i, /returns? to practice/i
];

export function classifyNews(item: Pick<NewsItem, 'headline' | 'summary'>): NewsSignal {
  const text = `${item.headline} ${item.summary || ''}`;
  if (NEGATIVE_NEWS.some(pattern => pattern.test(text))) return 'negative';
  if (POSITIVE_NEWS.some(pattern => pattern.test(text))) return 'positive';
  return 'neutral';
}

export function practiceLevel(practice: string | null | undefined): 'full' | 'limited' | 'dnp' | null {
  const text = (practice || '').toLowerCase();
  if (!text) return null;
  if (/did not|dnp|no participation/.test(text)) return 'dnp';
  if (/limited/.test(text)) return 'limited';
  if (/full/.test(text)) return 'full';
  return null;
}

export function playProbability(status: NormalizedInjuryStatus, practice: 'full' | 'limited' | 'dnp' | null, news: NewsSignal): { value: number; policy: string } {
  const base = BASE_PLAY_PROBABILITY[status];
  if (status === 'QUESTIONABLE') {
    let value: number = base;
    const notes = [`Questionable baseline ${base.toFixed(2)}`];
    if (practice === 'full') { value = 0.95; notes.push('full practice → 0.95'); }
    else if (practice === 'limited') { value = 0.8; notes.push('limited practice → 0.80'); }
    else if (practice === 'dnp') { value = 0.5; notes.push('did not practice → 0.50'); }
    if (news === 'negative') { value = Math.min(value, 0.5); notes.push('negative news caps at 0.50'); }
    if (news === 'positive') { value = Math.max(value, 0.95); notes.push('positive news raises to at least 0.95'); }
    return { value, policy: notes.join('; ') };
  }
  if (status === 'DOUBTFUL') return news === 'positive' ? { value: 0.4, policy: 'Doubtful with positive news → 0.40' } : { value: base, policy: `Doubtful → ${base.toFixed(2)}` };
  if (base === 0) return { value: 0, policy: `${status} → excluded from the lineup` };
  return { value: base, policy: status === 'ACTIVE' ? 'No availability concern → 1.00 (normal projection-first optimization)' : `${status} → ${base.toFixed(2)}` };
}

export interface AvailabilityInput {
  sleeper: SleeperPlayer | undefined;
  official?: NflverseInjuryRow;
  news: NewsItem[];
  sleeperRetrievedAt: string | null;
  sleeperStale: boolean;
  officialRetrievedAt: string | null;
  officialStale: boolean;
  gameTime: string | null;
  now: Date;
}

export function assessAvailability(input: AvailabilityInput): AvailabilityAssessment {
  const combined = combineInjuryStatus(input.sleeper, input.official);
  const status = combined.normalized;
  const sleeperStatus = normalizeInjuryStatus(input.sleeper?.injury_status || input.sleeper?.status, input.sleeper?.active !== false);
  const officialStatus = input.official?.report_status ? normalizeInjuryStatus(input.official.report_status, true) : null;
  const officialDrives = officialStatus != null && severity[officialStatus] >= severity[sleeperStatus] && officialStatus !== 'ACTIVE';
  const sleeperDrives = sleeperStatus !== 'ACTIVE' && severity[sleeperStatus] >= (officialStatus ? severity[officialStatus] : 0);
  const statusSource = officialDrives && sleeperDrives ? 'nflverse official injury report + Sleeper' : officialDrives ? 'nflverse official injury report' : 'Sleeper';
  const statusUpdatedAt = officialDrives && !sleeperDrives ? input.officialRetrievedAt : combined.lastUpdated;

  const practice = combined.practice;
  const level = practiceLevel(practice);
  const classified = input.news.map(item => ({ ...item, signal: classifyNews(item) }))
    .sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '') || 0);
  const decisive = classified.find(item => item.signal !== 'neutral');
  const latestNews = decisive || (status !== 'ACTIVE' ? classified[0] : undefined) || null;
  const newsSignal: NewsSignal = decisive?.signal || 'neutral';

  const { value, policy } = playProbability(status, level, newsSignal);
  const concern = status !== 'ACTIVE';
  const officialDesignation = Boolean(input.official?.report_status);
  const sourceStale = input.sleeperStale || (officialDrives && input.officialStale);

  const reasons: string[] = [];
  let confidence: AvailabilityAssessment['confidence'];
  const contradicted = (status === 'OUT' || status === 'DOUBTFUL' || status === 'IR') && (level === 'full' || newsSignal === 'positive');
  if (sourceStale) { confidence = 'Low'; reasons.push('The injury source could not be refreshed this run; an older cached copy was used.'); }
  else if (contradicted) { confidence = 'Low'; reasons.push('Sources conflict: the designation is severe but practice or news points the other way.'); }
  else if (concern && (officialDesignation || newsSignal === 'negative')) {
    confidence = 'High';
    reasons.push(officialDesignation ? 'Official NFL injury report designation for this week.' : 'Sleeper designation is corroborated by independent recent news.');
  } else if (concern) { confidence = 'Medium'; reasons.push('Single unofficial source (Sleeper); no official report or corroborating news found.'); }
  else if (newsSignal === 'negative') { confidence = 'Low'; reasons.push('Recent news suggests a concern, but neither Sleeper nor the official report lists a designation.'); }
  else { confidence = 'High'; reasons.push('No designation from Sleeper or the official report, and no negative news.'); }

  const riskFlag: RiskFlag = value === 0 ? 'EXCLUDED' : value <= 0.5 ? 'AVOID' : value < 1 || newsSignal === 'negative' ? 'WATCH' : 'NONE';
  const gameStarted = input.gameTime ? Date.parse(input.gameTime) <= input.now.getTime() : false;

  return {
    status, rawStatus: combined.rawStatus, injury: combined.bodyPart, practice, practiceLevel: level, statusSource, statusUpdatedAt,
    retrievedAt: officialDrives && !sleeperDrives ? input.officialRetrievedAt : input.sleeperRetrievedAt, sourceStale,
    latestNews, newsSignal, playProbability: value, riskFlag, confidence, confidenceReasons: reasons, gameStarted, policy
  };
}

/** The three fields derived from an assessment. The published projection (`weeklyPoints`) is never touched. */
export function availabilityFields(projection: number | null, availability: AvailabilityAssessment): { availability: AvailabilityAssessment; expectedPoints: number | null; eligible: boolean } {
  return {
    availability,
    expectedPoints: projection == null ? null : Math.round(projection * availability.playProbability * 100) / 100,
    eligible: availability.playProbability > 0
  };
}
