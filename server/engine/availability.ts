import type { AvailabilityAssessment, AvailabilityEvidence, NewsItem, NewsSignal, NormalizedInjuryStatus, RiskFlag, SleeperPlayer } from '../../shared/types.js';
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

/** News older than this (relative to now) is treated as history, not a current availability signal. */
export const NEWS_MAX_AGE_DAYS = 6;
/** A Sleeper Questionable/Doubtful label whose last update is older than this is probably a prior-week designation. */
export const SLEEPER_DESIGNATION_MAX_AGE_DAYS = 8;
const DAY_MS = 86_400_000;

export interface AvailabilityInput {
  sleeper: SleeperPlayer | undefined;
  official?: NflverseInjuryRow;
  news: NewsItem[];
  sleeperRetrievedAt: string | null;
  sleeperStale: boolean;
  officialRetrievedAt: string | null;
  /** nflverse's own `last-modified` for the injury report. */
  officialSourceUpdatedAt?: string | null;
  officialStale: boolean;
  gameTime: string | null;
  now: Date;
  targetWeek?: number;
}

/** Whether a news item can inform this week's availability; unusable items are kept as evidence with the reason. */
export function newsUsability(item: NewsItem, now: Date, targetWeek?: number): { usable: boolean; note?: string } {
  const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
  if (!Number.isFinite(published)) return { usable: false, note: 'No publication timestamp, so its freshness cannot be verified.' };
  if (published > now.getTime() + 3_600_000) return { usable: false, note: 'Publication timestamp is in the future.' };
  const ageDays = (now.getTime() - published) / DAY_MS;
  if (ageDays > NEWS_MAX_AGE_DAYS) return { usable: false, note: `Published ${Math.floor(ageDays)} days ago (older than ${NEWS_MAX_AGE_DAYS}); treated as history.` };
  if (targetWeek != null) {
    const text = `${item.headline} ${item.summary || ''}`;
    const weeks = [...text.matchAll(/\bweek\s*(\d{1,2})\b/gi)].map(match => Number(match[1]));
    if (weeks.length && !weeks.includes(targetWeek)) return { usable: false, note: `Refers to Week ${weeks[0]}, not the target Week ${targetWeek}.` };
  }
  return { usable: true };
}

function sleeperUpdatedAt(player: SleeperPlayer | undefined): string | null {
  const raw = player?.news_updated;
  return raw ? new Date(raw > 10_000_000_000 ? raw : raw * 1000).toISOString() : null;
}

export function assessAvailability(input: AvailabilityInput): AvailabilityAssessment {
  const combined = combineInjuryStatus(input.sleeper, input.official);
  const status = combined.normalized;
  const sleeperStatus = normalizeInjuryStatus(input.sleeper?.injury_status || input.sleeper?.status, input.sleeper?.active !== false);
  const officialStatus = input.official?.report_status ? normalizeInjuryStatus(input.official.report_status, true) : null;
  const officialDrives = officialStatus != null && severity[officialStatus] >= severity[sleeperStatus] && officialStatus !== 'ACTIVE';
  const sleeperDrives = sleeperStatus !== 'ACTIVE' && severity[sleeperStatus] >= (officialStatus ? severity[officialStatus] : 0);
  const statusSource = officialDrives && sleeperDrives ? 'nflverse official injury report + Sleeper' : officialDrives ? 'nflverse official injury report' : 'Sleeper';
  const officialPublishedAt = input.officialSourceUpdatedAt || null;
  const sleeperPublishedAt = sleeperUpdatedAt(input.sleeper);
  const statusUpdatedAt = officialDrives && !sleeperDrives ? (officialPublishedAt || input.officialRetrievedAt) : sleeperPublishedAt;

  const practice = combined.practice;
  const level = practiceLevel(practice);
  const evidence: AvailabilityEvidence[] = [];
  if (input.official?.report_status || input.official?.practice_status) {
    evidence.push({
      source: 'nflverse official injury report', kind: 'official-report',
      detail: `${input.official.report_status || 'no game designation'}${input.official.report_primary_injury ? ` (${input.official.report_primary_injury})` : ''}${input.official.practice_status ? `; practice: ${input.official.practice_status}` : ''}`,
      publishedAt: officialPublishedAt, retrievedAt: input.officialRetrievedAt, targetWeek: input.official.week ? Number(input.official.week) : (input.targetWeek ?? null), used: true
    });
  }
  const sleeperLabel = input.sleeper?.injury_status || (sleeperStatus !== 'ACTIVE' ? input.sleeper?.status : null);
  let sleeperPossiblyPriorWeek = false;
  if (sleeperLabel) {
    const ageDays = sleeperPublishedAt ? (input.now.getTime() - Date.parse(sleeperPublishedAt)) / DAY_MS : null;
    sleeperPossiblyPriorWeek = (sleeperStatus === 'QUESTIONABLE' || sleeperStatus === 'DOUBTFUL') && !input.official?.report_status && ageDays != null && ageDays > SLEEPER_DESIGNATION_MAX_AGE_DAYS;
    evidence.push({
      source: 'Sleeper player status', kind: 'sleeper-status', detail: `${sleeperLabel}${input.sleeper?.injury_body_part ? ` (${input.sleeper.injury_body_part})` : ''}${input.sleeper?.practice_description ? `; practice: ${input.sleeper.practice_description}` : ''}`,
      publishedAt: sleeperPublishedAt, retrievedAt: input.sleeperRetrievedAt, targetWeek: null, used: true,
      note: sleeperPossiblyPriorWeek
        ? `Last updated ${Math.floor(ageDays!)} days ago with no official report for Week ${input.targetWeek ?? '?'}: this may be a prior-week designation.`
        : 'Sleeper statuses are current as of retrieval and not tagged with a week.'
    });
  }

  const classified = input.news.map(item => {
    const usability = newsUsability(item, input.now, input.targetWeek);
    return { ...item, signal: classifyNews(item), usable: usability.usable, unusableNote: usability.note };
  }).sort((a, b) => Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '') || 0);
  for (const item of classified.filter(candidate => candidate.signal !== 'neutral')) {
    evidence.push({
      source: item.source, kind: 'news', detail: item.headline, publishedAt: item.publishedAt, retrievedAt: input.sleeperRetrievedAt,
      targetWeek: /\bweek\s*(\d{1,2})\b/i.exec(`${item.headline} ${item.summary || ''}`)?.[1] ? Number(/\bweek\s*(\d{1,2})\b/i.exec(`${item.headline} ${item.summary || ''}`)![1]) : null,
      used: item.usable && item.signal !== 'neutral', note: item.usable ? `Classified ${item.signal}.` : item.unusableNote
    });
  }
  const usableNews = classified.filter(item => item.usable);
  const decisive = usableNews.find(item => item.signal !== 'neutral');
  const strip = (item: (typeof classified)[number]) => ({ source: item.source, headline: item.headline, summary: item.summary, url: item.url, publishedAt: item.publishedAt, signal: item.signal });
  const latestNews = decisive ? strip(decisive) : status !== 'ACTIVE' && usableNews[0] ? strip(usableNews[0]) : null;
  const newsSignal: NewsSignal = decisive?.signal || 'neutral';

  const { value, policy } = playProbability(status, level, newsSignal);
  const concern = status !== 'ACTIVE';
  const officialDesignation = Boolean(input.official?.report_status);
  const sourceStale = input.sleeperStale || (officialDrives && input.officialStale);

  const reasons: string[] = [];
  let confidence: AvailabilityAssessment['confidence'];
  const contradicted = (status === 'OUT' || status === 'DOUBTFUL' || status === 'IR') && (level === 'full' || newsSignal === 'positive');
  const newsConflict = contradicted || (newsSignal === 'negative' && !concern);
  if (sourceStale) { confidence = 'Low'; reasons.push('The injury source could not be refreshed this run; an older cached copy was used.'); }
  else if (contradicted) { confidence = 'Low'; reasons.push('Sources conflict: the designation is severe but practice or news points the other way.'); }
  else if (sleeperPossiblyPriorWeek && !officialDesignation) { confidence = 'Low'; reasons.push('Only a Sleeper designation that has not been updated in over a week; it may be left over from a prior week.'); }
  else if (concern && (officialDesignation || newsSignal === 'negative')) {
    confidence = 'High';
    reasons.push(officialDesignation ? 'Official NFL injury report designation for this week.' : 'Sleeper designation is corroborated by independent recent news.');
  } else if (concern) { confidence = 'Medium'; reasons.push('Single unofficial source (Sleeper); no official report or corroborating news found.'); }
  else if (newsSignal === 'negative') { confidence = 'Low'; reasons.push('Recent news suggests a concern, but neither Sleeper nor the official report lists a designation.'); }
  else { confidence = 'High'; reasons.push('No designation from Sleeper or the official report, and no negative news.'); }
  const ignoredNews = classified.filter(item => !item.usable).length;
  if (ignoredNews) reasons.push(`${ignoredNews} news item${ignoredNews === 1 ? ' was' : 's were'} ignored as old, undated, or about another week.`);

  const riskFlag: RiskFlag = value === 0 ? 'EXCLUDED' : value <= 0.5 ? 'AVOID' : value < 1 || newsSignal === 'negative' ? 'WATCH' : 'NONE';
  const gameStarted = input.gameTime ? Date.parse(input.gameTime) <= input.now.getTime() : false;

  return {
    status, rawStatus: combined.rawStatus, injury: combined.bodyPart, practice, practiceLevel: level, statusSource, statusUpdatedAt,
    retrievedAt: officialDrives && !sleeperDrives ? input.officialRetrievedAt : input.sleeperRetrievedAt, sourceStale,
    latestNews, newsSignal, playProbability: value, riskFlag, confidence, confidenceReasons: reasons, gameStarted, policy,
    evidence, targetWeek: input.targetWeek, newsConflict
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
