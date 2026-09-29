import type { ScoringComponent } from '../../shared/types.js';

/** ESPN's per-player weekly projections are keyed by these numeric stat IDs. Documented publicly by the fantasy-football open-source community (e.g. https://gist.github.com/nntrn/ee26cb2a0716de0947a0a4e9a157bc1c) and cross-verified live against real ESPN payloads (assisted+solo tackles summing to total tackles; games-played stat equal to 1 for a single week). */
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
  { statId: '68', sleeperKey: 'fum_lost', positions: OFFENSE },
  { statId: '83', sleeperKey: 'fgm', positions: ['K'] },
  { statId: '80', sleeperKey: 'fga', positions: ['K'] },
  { statId: '77', sleeperKey: 'fgm_40_49', positions: ['K'] },
  { statId: '86', sleeperKey: 'xpm', positions: ['K'] },
  { statId: '87', sleeperKey: 'xpa', positions: ['K'] },
  { statId: '95', sleeperKey: 'def_int', positions: ['DEF'] },
  { statId: '96', sleeperKey: 'def_fum_rec', positions: ['DEF'] },
  { statId: '97', sleeperKey: 'def_blk_kick', positions: ['DEF'] },
  { statId: '98', sleeperKey: 'def_safe', positions: ['DEF'] },
  { statId: '99', sleeperKey: 'def_sack', positions: ['DEF'] },
  { statId: '106', sleeperKey: 'def_ff', positions: ['DEF'] },
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

/** Fields ESPN buckets in a way that only sometimes lines up with a league's own bonus buckets; combined/derived explicitly rather than 1:1 mapped. */
const COMPOSITE_KEYS = new Set(['bonus_pass_yd_300', 'bonus_pass_yd_400', 'bonus_rush_yd_100', 'bonus_rush_yd_200', 'bonus_rec_yd_100', 'bonus_rec_yd_200', 'def_td', 'def_st_td', 'idp_td', 'fgm_50p']);
const UNSUPPORTED_GRANULARITY = new Set(['fgm_0_19', 'fgm_20_29', 'fgm_30_39']);

function positionMatches(mapping: StatMapping, position: string): boolean {
  return mapping.positions.includes(position);
}

function scoringKeyRelevant(key: string, position: string): boolean {
  if (position === 'K') return /^(fg|xp)/.test(key);
  if (position === 'DEF') return /^(def_|pts_allow_|ret_yd)/.test(key) || key === 'sack' || key === 'int' || key === 'safe' || key === 'ff' || key === 'fum_rec';
  if (IDP.includes(position)) return key.startsWith('idp_');
  if (position === 'QB') return /^(pass_|rush_|fum|ret_|bonus_pass|bonus_rush)/.test(key);
  if (SKILL.includes(position)) return /^(rush_|rec|fum|ret_|bonus_rush|bonus_rec)/.test(key);
  return false;
}

export interface ScoredProjection {
  points: number | null;
  coverage: number;
  components: ScoringComponent[];
  unsupportedKeys: string[];
}

function num(stats: EspnStatLine, id: string): number | null {
  const value = stats[id];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function scoreEspnProjection(stats: EspnStatLine, scoring: Record<string, number>, position: string): ScoredProjection {
  const configuredKeys = Object.entries(scoring).filter(([key, value]) => value !== 0 && scoringKeyRelevant(key, position)).map(([key]) => key);
  const components: ScoringComponent[] = [];
  const modeledKeys = new Set<string>();
  const supportedKeys = new Set([...ESPN_STAT_MAP.filter(mapping => positionMatches(mapping, position)).map(mapping => mapping.sleeperKey), ...COMPOSITE_KEYS]);
  let points = 0;
  let hasProjectedStatistic = false;

  for (const mapping of ESPN_STAT_MAP) {
    if (!positionMatches(mapping, position)) continue;
    const multiplier = scoring[mapping.sleeperKey];
    if (multiplier == null || multiplier === 0) continue;
    const projectedStat = num(stats, mapping.statId);
    if (projectedStat == null) continue;
    const projectedPoints = projectedStat * multiplier;
    points += projectedPoints;
    hasProjectedStatistic = true;
    modeledKeys.add(mapping.sleeperKey);
    components.push({ providerStat: `espn:${mapping.statId}`, projectedStat, sleeperKey: mapping.sleeperKey, multiplier, projectedPoints: Math.round(projectedPoints * 1000) / 1000, modeled: true });
  }

  const composite = (key: string, statIds: string[], label: string) => {
    const multiplier = scoring[key];
    if (multiplier == null || multiplier === 0 || !scoringKeyRelevant(key, position)) return;
    const values = statIds.map(id => num(stats, id));
    if (values.every(value => value == null)) return;
    const projectedStat = values.reduce((sum: number, value) => sum + (value ?? 0), 0);
    const projectedPoints = projectedStat * multiplier;
    points += projectedPoints;
    hasProjectedStatistic = true;
    modeledKeys.add(key);
    components.push({ providerStat: label, projectedStat, sleeperKey: key, multiplier, projectedPoints: Math.round(projectedPoints * 1000) / 1000, modeled: true });
  };
  if (position === 'QB') { composite('bonus_pass_yd_300', ['17', '18'], 'espn:17+18 (300-399 or 400+ yard passing game)'); composite('bonus_pass_yd_400', ['18'], 'espn:18 (400+ yard passing game)'); }
  if (OFFENSE.includes(position)) { composite('bonus_rush_yd_100', ['37', '38'], 'espn:37+38 (100+ yard rushing game)'); composite('bonus_rush_yd_200', ['38'], 'espn:38 (200+ yard rushing game)'); }
  if (SKILL.includes(position)) { composite('bonus_rec_yd_100', ['56', '57'], 'espn:56+57 (100+ yard receiving game)'); composite('bonus_rec_yd_200', ['57'], 'espn:57 (200+ yard receiving game)'); }
  if (position === 'DEF') { composite('def_td', ['103', '104'], 'espn:103+104 (INT/fumble return TD)'); composite('def_st_td', ['105'], 'espn:105 (total return TD)'); }
  if (IDP.includes(position)) composite('idp_td', ['103', '104'], 'espn:103+104 (INT/fumble return TD)');
  if (position === 'K') composite('fgm_50p', ['74', '201'], 'espn:74+201 (50+ yard FG made)');

  const unsupportedKeys = configuredKeys.filter(key => !supportedKeys.has(key) || UNSUPPORTED_GRANULARITY.has(key));
  for (const key of configuredKeys.filter(key => !modeledKeys.has(key))) {
    const supported = supportedKeys.has(key) && !UNSUPPORTED_GRANULARITY.has(key);
    components.push({
      providerStat: 'unavailable', projectedStat: null, sleeperKey: key, multiplier: scoring[key], projectedPoints: null, modeled: false,
      note: UNSUPPORTED_GRANULARITY.has(key)
        ? 'ESPN groups 0-39 yard field goals into a single bucket; this league\'s finer distance bonus cannot be safely split from it.'
        : supported ? 'ESPN\'s projection did not include this documented statistic for the player this week.' : 'ESPN does not provide a documented statistic that can be safely mapped to this scoring rule.'
    });
  }
  const coverage = configuredKeys.length ? Math.round(modeledKeys.size / configuredKeys.length * 100) : (hasProjectedStatistic ? 100 : 0);
  return { points: hasProjectedStatistic ? Math.round(points * 100) / 100 : null, coverage, components, unsupportedKeys };
}
