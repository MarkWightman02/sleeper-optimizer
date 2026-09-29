import type { NormalizedInjuryStatus, SleeperPlayer } from '../../shared/types.js';

export interface NflverseInjuryRow {
  gsis_id: string;
  week?: string;
  report_status?: string | null;
  report_primary_injury?: string | null;
  practice_status?: string | null;
}

export const severity: Record<NormalizedInjuryStatus, number> = { ACTIVE: 0, UNKNOWN: 1, QUESTIONABLE: 2, DOUBTFUL: 3, SUSPENDED: 4, PUP: 5, OUT: 6, IR: 7 };

export function normalizeInjuryStatus(raw?: string | null, active = true): NormalizedInjuryStatus {
  const value = (raw || '').trim().toUpperCase().replace(/[^A-Z-]/g, '');
  if (value === 'Q' || value.includes('QUESTION')) return 'QUESTIONABLE';
  if (value === 'D' || value.includes('DOUBT')) return 'DOUBTFUL';
  if (value === 'O' || value === 'OUT' || value === 'INACTIVE' || value === 'NOTSTARTING' || value === 'NS') return 'OUT';
  if (value === 'IR' || value.includes('INJUREDRESERVE')) return 'IR';
  if (value.includes('PUP')) return 'PUP';
  if (value === 'S' || value.includes('SUSPEND')) return 'SUSPENDED';
  if (!value && active) return 'ACTIVE';
  if (value === 'ACTIVE' || value === 'HEALTHY' || value === 'FULL') return 'ACTIVE';
  return active ? 'UNKNOWN' : 'OUT';
}

export function combineInjuryStatus(player: SleeperPlayer | undefined, nflverse?: NflverseInjuryRow): {
  normalized: NormalizedInjuryStatus;
  rawStatus: string | null;
  bodyPart: string | null;
  practice: string | null;
  lastUpdated: string | null;
  probabilityOfPlaying: number | null;
} {
  const sleeperStatus = normalizeInjuryStatus(player?.injury_status || player?.status, player?.active !== false);
  const officialStatus = nflverse?.report_status ? normalizeInjuryStatus(nflverse.report_status, true) : 'ACTIVE';
  const normalized = severity[officialStatus] > severity[sleeperStatus] ? officialStatus : sleeperStatus;
  const sleeperNewsDate = player?.news_updated
    ? new Date(player.news_updated > 10_000_000_000 ? player.news_updated : player.news_updated * 1000).toISOString()
    : null;
  return {
    normalized,
    rawStatus: nflverse?.report_status || player?.injury_status || player?.status || null,
    bodyPart: nflverse?.report_primary_injury || player?.injury_body_part || null,
    practice: nflverse?.practice_status || player?.practice_participation || player?.practice_description || null,
    lastUpdated: sleeperNewsDate,
    probabilityOfPlaying: null
  };
}

/** Baseline probability a player suits up given only the designation. Documented in ARCHITECTURE.md ("Availability policy"). */
export const BASE_PLAY_PROBABILITY: Record<NormalizedInjuryStatus, number> = {
  ACTIVE: 1, UNKNOWN: 0.9, QUESTIONABLE: 0.85, DOUBTFUL: 0.25, OUT: 0, IR: 0, PUP: 0, SUSPENDED: 0
};
