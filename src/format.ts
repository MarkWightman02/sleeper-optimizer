import type { LineupDecision } from '../shared/types';

export const fmt = (value: number | null | undefined) => value == null ? 'unavailable' : value.toFixed(1);
export const fmtTime = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : 'not reported';
export const signed = (value: number | null | undefined, digits = 1) => value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;
export const signedSmart = (value: number | null | undefined) => value == null ? '—' : signed(value, value !== 0 && Math.abs(value) < 0.1 ? 2 : 1);

/** Projection gaps below this many points are shown as close/even in the matchup view. */
export const CLOSE_MARGIN = 1;

export const KIND_LABEL: Record<LineupDecision['kind'], string> = {
  PROJECTION: 'PROJECTION', CLOSE_CALL: 'CLOSE CALL', TOSS_UP: 'TOSS-UP',
  AVAILABILITY_EXCLUSION: 'AVAILABILITY OVERRIDE', AVAILABILITY_DISCOUNT: 'AVAILABILITY OVERRIDE', NO_PROJECTION: 'NO PROJECTION'
};

export const isOverride = (decision?: LineupDecision | null) => decision?.kind === 'AVAILABILITY_EXCLUSION' || decision?.kind === 'AVAILABILITY_DISCOUNT';
