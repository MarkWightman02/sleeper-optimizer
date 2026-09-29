import type { SourceOutcome } from '../providers/types.js';
import { getProviderCache, putProviderCache } from '../db.js';
import { parseCsv } from '../utils/csv.js';

const SOURCE = 'DynastyProcess Player ID Crosswalk';
const URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
const TTL = 24 * 60 * 60 * 1000;

export interface CrosswalkRow {
  sleeper_id: string | null;
  gsis_id: string | null;
  espn_id: string | null;
  yahoo_id: string | null;
  pff_id: string | null;
  rotowire_id: string | null;
  name: string;
  merge_name: string;
  position: string | null;
  team: string | null;
}

export interface CrosswalkIndex {
  bySleeperId: Map<string, CrosswalkRow>;
  byGsisId: Map<string, CrosswalkRow>;
  byEspnId: Map<string, CrosswalkRow>;
  retrievedAt: string | null;
  rowCount: number;
}

function clean(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === 'NA' ? null : trimmed;
}

function toRow(record: Record<string, string>): CrosswalkRow {
  return {
    sleeper_id: clean(record.sleeper_id),
    gsis_id: clean(record.gsis_id),
    espn_id: clean(record.espn_id),
    yahoo_id: clean(record.yahoo_id),
    pff_id: clean(record.pff_id),
    rotowire_id: clean(record.rotowire_id),
    name: record.name || '',
    merge_name: record.merge_name || '',
    position: clean(record.position),
    team: clean(record.team)
  };
}

function buildIndex(rows: CrosswalkRow[], retrievedAt: string | null): CrosswalkIndex {
  const bySleeperId = new Map<string, CrosswalkRow>();
  const byGsisId = new Map<string, CrosswalkRow>();
  const byEspnId = new Map<string, CrosswalkRow>();
  for (const row of rows) {
    if (row.sleeper_id) bySleeperId.set(row.sleeper_id, row);
    if (row.gsis_id) byGsisId.set(row.gsis_id, row);
    if (row.espn_id) byEspnId.set(row.espn_id, row);
  }
  return { bySleeperId, byGsisId, byEspnId, retrievedAt, rowCount: rows.length };
}

let cached: CrosswalkIndex | null = null;

export async function loadCrosswalk(forceRefresh = false): Promise<{ index: CrosswalkIndex; outcome: SourceOutcome }> {
  if (!forceRefresh && cached) return { index: cached, outcome: { name: SOURCE, kind: 'identity', status: 'SUCCESS', retrievedAt: cached.retrievedAt } };
  if (!forceRefresh) {
    const hit = getProviderCache<Record<string, string>[]>('crosswalk', 'db_playerids', TTL);
    if (hit) {
      cached = buildIndex(hit.value.map(toRow), hit.retrievedAt);
      return { index: cached, outcome: { name: SOURCE, kind: 'identity', status: 'SUCCESS', retrievedAt: hit.retrievedAt } };
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(URL, { signal: controller.signal, headers: { accept: 'text/csv', 'user-agent': 'SleeperOptimizer/1.0 (+read-only fantasy football research tool)' } });
    if (!response.ok) throw new Error(`Crosswalk request returned HTTP ${response.status}`);
    const text = await response.text();
    const records = parseCsv(text);
    if (!records.length) throw new Error('Crosswalk response parsed to zero rows');
    const retrievedAt = putProviderCache('crosswalk', 'db_playerids', records);
    cached = buildIndex(records.map(toRow), retrievedAt);
    return { index: cached, outcome: { name: SOURCE, kind: 'identity', status: 'SUCCESS', retrievedAt } };
  } catch (error) {
    const stale = getProviderCache<Record<string, string>[]>('crosswalk', 'db_playerids', Infinity);
    if (stale) {
      cached = buildIndex(stale.value.map(toRow), stale.retrievedAt);
      return { index: cached, outcome: { name: SOURCE, kind: 'identity', status: 'SUCCESS', detail: 'Static reference data: using last cached copy after a refresh failure.', retrievedAt: stale.retrievedAt } };
    }
    return {
      index: { bySleeperId: new Map(), byGsisId: new Map(), byEspnId: new Map(), retrievedAt: null, rowCount: 0 },
      outcome: { name: SOURCE, kind: 'identity', status: error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : 'FAILED', detail: error instanceof Error ? error.message : String(error), retrievedAt: null }
    };
  } finally { clearTimeout(timer); }
}
