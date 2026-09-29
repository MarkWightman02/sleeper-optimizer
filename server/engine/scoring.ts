import type { ScoringComponent } from '../../shared/types.js';

/**
 * ESPN publishes each weekly projection as a numeric stat line keyed by stat ID. Every ID below was verified against nflverse
 * actual results for the same weeks (see ARCHITECTURE.md "ESPN stat IDs"); nothing is guessed. Team-defense and kicker IDs were
 * additionally decoded from the shape of ESPN's projected lines (probability-mass buckets that sum to 1).
 */
export type EspnStatLine = Record<string, number | null | undefined>;

interface StatMapping { statId: string; sleeperKey: string; positions: string[] }

const OFFENSE = ['QB', 'RB', 'WR', 'TE'];
const SKILL = ['RB', 'WR', 'TE'];
const IDP = ['DL', 'LB', 'DB'];

export const ESPN_STAT_MAP: StatMapping[] = [
  { statId: '0', sleeperKey: 'pass_att', positions: ['QB'] },
  { statId: '1', sleeperKey: 'pass_cmp', positions: ['QB'] },
  { statId: '3', sleeperKey: 'pass_yd', positions: ['QB'] },
  { statId: '4', sleeperKey: 'pass_td', positions: ['QB'] },
  { statId: '20', sleeperKey: 'pass_int', positions: ['QB'] },
  { statId: '19', sleeperKey: 'pass_2pt', positions: ['QB'] },
  { statId: '23', sleeperKey: 'rush_att', positions: OFFENSE },
  { statId: '24', sleeperKey: 'rush_yd', positions: OFFENSE },
  { statId: '25', sleeperKey: 'rush_td', positions: OFFENSE },
  { statId: '26', sleeperKey: 'rush_2pt', positions: OFFENSE },
  { statId: '53', sleeperKey: 'rec', positions: SKILL },
  { statId: '42', sleeperKey: 'rec_yd', positions: SKILL },
  { statId: '43', sleeperKey: 'rec_td', positions: SKILL },
  { statId: '44', sleeperKey: 'rec_2pt', positions: SKILL },
  { statId: '58', sleeperKey: 'rec_tgt', positions: SKILL },
  { statId: '68', sleeperKey: 'fum', positions: OFFENSE },
  { statId: '72', sleeperKey: 'fum_lost', positions: OFFENSE },
  { statId: '83', sleeperKey: 'fgm', positions: ['K'] },
  { statId: '77', sleeperKey: 'fgm_40_49', positions: ['K'] },
  { statId: '85', sleeperKey: 'fgmiss', positions: ['K'] },
  { statId: '86', sleeperKey: 'xpm', positions: ['K'] },
  { statId: '88', sleeperKey: 'xpmiss', positions: ['K'] },
  { statId: '99', sleeperKey: 'sack', positions: ['DEF'] },
  { statId: '95', sleeperKey: 'int', positions: ['DEF'] },
  { statId: '96', sleeperKey: 'fum_rec', positions: ['DEF'] },
  { statId: '106', sleeperKey: 'ff', positions: ['DEF'] },
  { statId: '98', sleeperKey: 'safe', positions: ['DEF'] },
  { statId: '97', sleeperKey: 'blk_kick', positions: ['DEF'] },
  { statId: '95', sleeperKey: 'idp_int', positions: IDP },
  { statId: '96', sleeperKey: 'idp_fum_rec', positions: IDP },
  { statId: '97', sleeperKey: 'idp_blk_kick', positions: IDP },
  { statId: '98', sleeperKey: 'idp_safe', positions: IDP },
  { statId: '99', sleeperKey: 'idp_sack', positions: IDP },
  { statId: '106', sleeperKey: 'idp_ff', positions: IDP },
  { statId: '107', sleeperKey: 'idp_tkl_ast', positions: IDP },
  { statId: '108', sleeperKey: 'idp_tkl_solo', positions: IDP },
  { statId: '109', sleeperKey: 'idp_tkl', positions: IDP },
  { statId: '112', sleeperKey: 'idp_tkl_loss', positions: IDP },
  { statId: '113', sleeperKey: 'idp_pass_def', positions: IDP },
  { statId: '114', sleeperKey: 'ret_yd', positions: [...OFFENSE, 'DEF', ...IDP] },
  { statId: '115', sleeperKey: 'ret_yd', positions: [...OFFENSE, 'DEF', ...IDP] }
];

/** Sleeper rules that share one ESPN bucket. Scored from the bucket only when every rule in it has the same value (else unsupported). */
const KICKER_BUCKETS: Array<{ statId: string; keys: string[]; label: string; primary?: string }> = [
  { statId: '80', keys: ['fgm_0_19', 'fgm_20_29', 'fgm_30_39'], label: 'FG made 0-39 yards' },
  { statId: '74', keys: ['fgm_50_59', 'fgm_60p'], label: 'FG made 50+ yards', primary: 'fgm_50_59' }
];

/** ESPN's projected points-allowed lines are probabilities over these buckets (they sum to 1). */
const PA_BUCKETS: Array<{ statId: string; lo: number; hi: number }> = [
  { statId: '89', lo: 0, hi: 0 }, { statId: '90', lo: 1, hi: 6 }, { statId: '91', lo: 7, hi: 13 }, { statId: '92', lo: 14, hi: 17 },
  { statId: '121', lo: 18, hi: 21 }, { statId: '122', lo: 22, hi: 27 }, { statId: '123', lo: 28, hi: 34 }, { statId: '124', lo: 35, hi: 45 },
  { statId: '125', lo: 46, hi: Infinity }
];

/** Defensive scores built from several ESPN stats (ESPN 93 = blocked-kick TD; 105 = 93+101+102+103+104 in ESPN's own lines). */
const DEF_COMPOSITES: Array<{ key: string; statIds: string[]; label: string }> = [
  { key: 'def_td', statIds: ['103', '104', '93'], label: 'espn:103+104+93 (interception, fumble-return and blocked-kick TD)' },
  { key: 'def_st_td', statIds: ['101', '102'], label: 'espn:101+102 (kickoff and punt return TD)' }
];

/**
 * Rare events whose absence from ESPN's line changes a projection by a fraction of a point. They are reported
 * (`minorUnmodeledKeys`) but excluded from the coverage denominator so they cannot mask real gaps.
 */
export const MINOR_KEYS = new Set(['def_st_ff', 'def_st_fum_rec', 'fgm_60p', 'fum_rec_td', 'st_td', 'st_ff', 'st_fum_rec']);

function isMinor(key: string, position: string): boolean {
  return MINOR_KEYS.has(key) || (OFFENSE.includes(position) && key === 'fum_rec');
}

/** A projection is only produced when at least one of these core statistics is present in the ESPN line. */
const REQUIRED_ANY: Record<string, string[]> = {
  QB: ['3'], RB: ['24', '42'], WR: ['42'], TE: ['42'], K: ['83', '86'], DEF: ['99', '120'], DL: ['109', '108'], LB: ['109', '108'], DB: ['109', '108']
};

const COMPOSITE_KEYS = new Set(['bonus_pass_yd_300', 'bonus_pass_yd_400', 'bonus_rush_yd_100', 'bonus_rush_yd_200', 'bonus_rec_yd_100', 'bonus_rec_yd_200', 'idp_td']);

function isPaKey(key: string): boolean { return key.startsWith('pts_allow_'); }

function paRange(key: string): [number, number] | null {
  const match = /^pts_allow_(\d+)(?:_(\d+)|(p))?$/.exec(key);
  if (!match) return null;
  const lo = Number(match[1]);
  return [lo, match[2] != null ? Number(match[2]) : match[3] ? Infinity : lo];
}

function scoringKeyRelevant(key: string, position: string): boolean {
  if (position === 'K') return /^(fg|xp)/.test(key);
  if (position === 'DEF') return isPaKey(key) || ['sack', 'int', 'safe', 'ff', 'fum_rec', 'blk_kick', 'def_td', 'def_st_td', 'def_st_ff', 'def_st_fum_rec'].includes(key);
  if (IDP.includes(position)) return key.startsWith('idp_');
  if (position === 'QB') return /^(pass_|rush_|fum|ret_|bonus_pass|bonus_rush)/.test(key);
  if (SKILL.includes(position)) return /^(rush_|rec|fum|ret_|bonus_rush|bonus_rec)/.test(key);
  return false;
}

export interface ScoredProjection {
  points: number | null;
  /** Share (0-100) of this league's material scoring rules that ESPN's data can express. */
  coverage: number;
  components: ScoringComponent[];
  /** Material scoring rules ESPN's data cannot express. */
  unsupportedKeys: string[];
  /** Rare-event rules ignored on purpose (each worth a small fraction of a point). */
  minorUnmodeledKeys: string[];
  /** Rules ESPN expresses but whose statistic is absent from this player's line (no volume projected → contributes nothing). */
  omittedKeys: string[];
  /** The exact raw ESPN stat entries that fed the conversion, by stat ID. */
  statLine: Record<string, number>;
  /** Places where a documented assumption was needed to convert (e.g. a bucket straddling a league boundary). */
  approximations: string[];
  reason?: string;
}

function num(stats: EspnStatLine, id: string): number | null {
  const value = stats[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function scoreEspnProjection(stats: EspnStatLine, scoring: Record<string, number>, position: string): ScoredProjection {
  const relevant = Object.entries(scoring).filter(([key]) => scoringKeyRelevant(key, position));
  const configured = relevant.filter(([, value]) => value !== 0).map(([key]) => key);
  const minorUnmodeledKeys: string[] = [];
  const material = configured.filter(key => {
    if (!isMinor(key, position)) return true;
    minorUnmodeledKeys.push(key);
    return false;
  });
  const components: ScoringComponent[] = [];
  const modeled = new Set<string>();
  const omitted: string[] = [];
  const statLine: Record<string, number> = {};
  const approximations: string[] = [];
  const used = (id: string) => { const value = num(stats, id); if (value != null) statLine[id] = value; return value; };
  let points = 0;

  const required = REQUIRED_ANY[position] || [];
  if (required.length && !required.some(id => num(stats, id) != null)) {
    return { points: null, coverage: 0, components, unsupportedKeys: material, minorUnmodeledKeys, omittedKeys: [], statLine, approximations, reason: `ESPN's line has none of the core statistics (${required.map(id => `espn:${id}`).join(', ')}) for a ${position}.` };
  }

  const add = (key: string, providerStat: string, projectedStat: number, multiplier: number, note?: string) => {
    const projectedPoints = projectedStat * multiplier;
    points += projectedPoints;
    modeled.add(key);
    components.push({ providerStat, projectedStat: round3(projectedStat), sleeperKey: key, multiplier, projectedPoints: round3(projectedPoints), modeled: true, ...(note ? { note } : {}) });
  };
  const omit = (key: string, multiplier: number, providerStat: string) => {
    modeled.add(key);
    omitted.push(key);
    components.push({ providerStat, projectedStat: null, sleeperKey: key, multiplier, projectedPoints: 0, modeled: true, note: 'ESPN omits this statistic from the player\'s line, i.e. no volume is projected; it contributes nothing.' });
  };

  const byKey = new Map<string, StatMapping[]>();
  for (const mapping of ESPN_STAT_MAP) if (mapping.positions.includes(position)) byKey.set(mapping.sleeperKey, [...(byKey.get(mapping.sleeperKey) || []), mapping]);
  for (const [key, mappings] of byKey) {
    const multiplier = scoring[key];
    if (multiplier == null || multiplier === 0) continue;
    const present = mappings.filter(mapping => used(mapping.statId) != null);
    if (!present.length) { omit(key, multiplier, mappings.map(mapping => `espn:${mapping.statId}`).join('+')); continue; }
    for (const mapping of present) add(key, `espn:${mapping.statId}`, statLine[mapping.statId], multiplier);
  }

  const composite = (key: string, statIds: string[], label: string) => {
    const multiplier = scoring[key];
    if (multiplier == null || multiplier === 0 || !scoringKeyRelevant(key, position) && !COMPOSITE_KEYS.has(key)) return;
    const values = statIds.map(id => used(id));
    if (values.every(value => value == null)) { omit(key, multiplier, label); return; }
    add(key, label, values.reduce((sum: number, value) => sum + (value ?? 0), 0), multiplier);
  };
  if (position === 'QB') { composite('bonus_pass_yd_300', ['17', '18'], 'espn:17+18 (300-399 or 400+ yard passing game)'); composite('bonus_pass_yd_400', ['18'], 'espn:18 (400+ yard passing game)'); }
  if (OFFENSE.includes(position)) { composite('bonus_rush_yd_100', ['37', '38'], 'espn:37+38 (100+ yard rushing game)'); composite('bonus_rush_yd_200', ['38'], 'espn:38 (200+ yard rushing game)'); }
  if (SKILL.includes(position)) { composite('bonus_rec_yd_100', ['56', '57'], 'espn:56+57 (100+ yard receiving game)'); composite('bonus_rec_yd_200', ['57'], 'espn:57 (200+ yard receiving game)'); }
  if (position === 'DEF') for (const item of DEF_COMPOSITES) composite(item.key, item.statIds, item.label);
  if (IDP.includes(position)) composite('idp_td', ['103', '104'], 'espn:103+104 (INT/fumble return TD)');

  if (position === 'K') {
    for (const bucket of KICKER_BUCKETS) {
      const rates = bucket.keys.map(key => scoring[key] ?? 0);
      if (rates.every(rate => rate === 0)) continue;
      const uniform = rates.every(rate => rate === rates[0]);
      if (!uniform && !bucket.primary) continue;
      const rate = uniform ? rates[0] : scoring[bucket.primary!];
      const covered = uniform ? bucket.keys : [bucket.primary!];
      const value = used(bucket.statId);
      if (value == null) { for (const key of covered) omit(key, rate, `espn:${bucket.statId}`); continue; }
      add(covered[0], `espn:${bucket.statId} (${bucket.label})`, value, rate, uniform
        ? `ESPN reports one bucket for ${bucket.label}; this league scores ${bucket.keys.join(', ')} identically (${rate}), so the bucket converts exactly.`
        : `ESPN reports one 50+ yard bucket; it is scored at the ${bucket.primary} rate (${rate}). 60+ yard makes are rare and are not split out.`);
      for (const key of covered) modeled.add(key);
      if (!uniform) approximations.push(`${bucket.label} scored at the ${bucket.primary} rate`);
    }
  }

  if (position === 'DEF') {
    const paKeys = Object.keys(scoring).filter(isPaKey);
    const activePa = paKeys.filter(key => scoring[key] !== 0);
    if (activePa.length) {
      const masses = PA_BUCKETS.map(bucket => ({ ...bucket, mass: used(bucket.statId) }));
      const total = masses.reduce((sum, bucket) => sum + (bucket.mass ?? 0), 0);
      if (masses.some(bucket => bucket.mass == null) || total < 0.9 || total > 1.1) {
        return { points: null, coverage: 0, components, unsupportedKeys: material, minorUnmodeledKeys, omittedKeys: [], statLine, approximations, reason: 'ESPN\'s points-allowed probability buckets are missing or do not sum to 1, so the defense cannot be scored safely.' };
      } else {
        const allocated = new Map<string, { mass: number; ids: Set<string>; split: boolean }>();
        for (const key of paKeys) allocated.set(key, { mass: 0, ids: new Set(), split: false });
        for (const bucket of masses) {
          const size = bucket.hi === Infinity ? Infinity : bucket.hi - bucket.lo + 1;
          for (const key of paKeys) {
            const range = paRange(key);
            if (!range) continue;
            const overlap = bucket.hi === Infinity
              ? (range[1] === Infinity && range[0] <= bucket.lo ? 1 : range[0] <= bucket.lo && range[1] >= bucket.lo ? 1 : 0)
              : Math.max(0, Math.min(bucket.hi, range[1]) - Math.max(bucket.lo, range[0]) + 1) / size;
            if (overlap <= 0) continue;
            const entry = allocated.get(key)!;
            entry.mass += bucket.mass! * overlap;
            entry.ids.add(bucket.statId);
            if (overlap < 1) entry.split = true;
          }
        }
        for (const key of activePa) {
          const entry = allocated.get(key)!;
          const split = entry.split;
          if (split && !approximations.some(text => text.startsWith('points-allowed'))) approximations.push('points-allowed: an ESPN bucket straddles a league bucket boundary, so its probability is split evenly across the integer scores it covers');
          add(key, `espn:${[...entry.ids].join('+')} (probability of ${key.replace('pts_allow_', '').replace('_', '-')} points allowed)`, entry.mass, scoring[key], split ? 'Includes a probability share split evenly across the scores of a straddling ESPN bucket (ESPN groups 18-21 points allowed; this league splits at 20/21).' : undefined);
        }
      }
    }
  }

  const supported = new Set([
    ...ESPN_STAT_MAP.filter(mapping => mapping.positions.includes(position)).map(mapping => mapping.sleeperKey),
    ...COMPOSITE_KEYS, ...(position === 'DEF' ? [...DEF_COMPOSITES.map(item => item.key), ...Object.keys(scoring).filter(isPaKey)] : []),
    ...(position === 'K' ? KICKER_BUCKETS.flatMap(bucket => bucket.keys) : [])
  ]);
  const unsupportedKeys: string[] = [];
  for (const key of material) {
    if (modeled.has(key)) continue;
    unsupportedKeys.push(key);
    components.push({
      providerStat: 'unavailable', projectedStat: null, sleeperKey: key, multiplier: scoring[key], projectedPoints: null, modeled: false,
      note: supported.has(key) ? 'ESPN\'s buckets cannot be safely converted to this league\'s finer rule.' : 'ESPN does not provide a documented statistic that can be safely mapped to this scoring rule.'
    });
  }
  const coverage = material.length ? Math.round(material.filter(key => modeled.has(key)).length / material.length * 100) : 100;
  return { points: Math.round(points * 100) / 100, coverage, components, unsupportedKeys, minorUnmodeledKeys: [...new Set(minorUnmodeledKeys)].filter(key => !modeled.has(key)), omittedKeys: omitted, statLine, approximations };
}
