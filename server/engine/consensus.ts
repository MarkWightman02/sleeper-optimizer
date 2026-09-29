import type { MappingConfidence, NormalizedInjuryStatus, PlayerEvaluation, ProjectionValue } from '../../shared/types.js';

export interface Consensus { points: number | null; coverage: number }

/** Transparent, unweighted average of every published numeric projection. Every individual value is retained on the player (`projections`); this only produces the single headline number. */
export function combineProjections(values: ProjectionValue[]): Consensus {
  if (!values.length) return { points: null, coverage: 0 };
  const points = Math.round((values.reduce((sum, value) => sum + value.points, 0) / values.length) * 100) / 100;
  const coverage = Math.round(values.reduce((sum, value) => sum + (value.coverage ?? 0), 0) / values.length);
  return { points, coverage };
}

export interface ConfidenceInputs {
  projectionValues: number[];
  rankingCount: number;
  mappingConfidence: MappingConfidence;
  normalizedInjuryStatus: NormalizedInjuryStatus;
  coverage: number;
}

/**
 * Documented, deterministic confidence scoring (spec §12): starts at 0, then adds/subtracts fixed weights for
 * source count, numeric agreement between projection sources, ranking support, identity-mapping certainty,
 * scoring coverage, and injury/availability uncertainty. Never itself a projection — only how much to trust one.
 */
export function computeConfidence(inputs: ConfidenceInputs): PlayerEvaluation['confidence'] {
  const { projectionValues, rankingCount, mappingConfidence, normalizedInjuryStatus, coverage } = inputs;
  if (!projectionValues.length && !rankingCount) return 'Unavailable';
  let score = 0;
  if (projectionValues.length >= 2) score += 2;
  else if (projectionValues.length === 1) score += 1;
  if (projectionValues.length >= 2) {
    const mean = projectionValues.reduce((sum, value) => sum + value, 0) / projectionValues.length;
    const spread = Math.max(...projectionValues) - Math.min(...projectionValues);
    const relativeSpread = mean > 0 ? spread / mean : spread;
    score += relativeSpread <= 0.15 ? 1 : relativeSpread >= 0.4 ? -2 : 0;
  }
  if (rankingCount >= 2) score += 1;
  if (mappingConfidence === 'exact' || mappingConfidence === 'high') score += 1;
  else if (mappingConfidence === 'low' || mappingConfidence === 'medium') score -= 1;
  else if (mappingConfidence === 'unmapped' || mappingConfidence === 'ambiguous') score -= 3;
  if (coverage >= 85) score += 1;
  else if (coverage > 0 && coverage < 50) score -= 1;
  if (normalizedInjuryStatus === 'QUESTIONABLE' || normalizedInjuryStatus === 'UNKNOWN') score -= 1;
  else if (['DOUBTFUL', 'OUT', 'IR', 'PUP', 'SUSPENDED'].includes(normalizedInjuryStatus)) score -= 2;
  if (score >= 3) return 'High';
  if (score >= 0) return 'Medium';
  return 'Low';
}
