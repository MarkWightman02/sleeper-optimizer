import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisHistoryItem, AnalysisResult, AppConfig, MappingConfidence, SleeperPlayer } from '../shared/types.js';

const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'sleeper-optimizer.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS app_config (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS analyses (id TEXT PRIMARY KEY, value TEXT NOT NULL, analyzed_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS analyses_date ON analyses(analyzed_at DESC);
  CREATE TABLE IF NOT EXISTS provider_cache (
    source TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    season TEXT,
    week INTEGER,
    value TEXT NOT NULL,
    retrieved_at TEXT NOT NULL,
    PRIMARY KEY(source, cache_key)
  );
  CREATE TABLE IF NOT EXISTS player_mappings (
    provider TEXT NOT NULL,
    sleeper_player_id TEXT NOT NULL,
    provider_player_id TEXT NOT NULL,
    match_method TEXT NOT NULL,
    confidence TEXT NOT NULL,
    last_verified_at TEXT NOT NULL,
    PRIMARY KEY(provider, sleeper_player_id),
    UNIQUE(provider, provider_player_id)
  );
  CREATE INDEX IF NOT EXISTS provider_cache_source ON provider_cache(source, retrieved_at DESC);
`);

export interface PlayerMappingRow {
  provider: string;
  sleeper_player_id: string;
  provider_player_id: string;
  match_method: string;
  confidence: MappingConfidence;
  last_verified_at: string;
}

export function getConfig(): AppConfig | null {
  const row = db.prepare('SELECT value FROM app_config WHERE id = 1').get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as AppConfig : null;
}

export function saveConfig(config: AppConfig): void {
  db.prepare(`INSERT INTO app_config(id, value, updated_at) VALUES(1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run(JSON.stringify(config), new Date().toISOString());
}

export function clearConfig(): void {
  db.prepare('DELETE FROM app_config WHERE id = 1').run();
}

export function getCachedPlayers(maxAgeMs: number): Record<string, SleeperPlayer> | null {
  const row = db.prepare("SELECT value, fetched_at FROM cache WHERE key = 'sleeper_players'").get() as { value: string; fetched_at: string } | undefined;
  if (!row || Date.now() - Date.parse(row.fetched_at) >= maxAgeMs) return null;
  return JSON.parse(row.value) as Record<string, SleeperPlayer>;
}

export function getStalePlayers(): Record<string, SleeperPlayer> | null {
  const row = db.prepare("SELECT value FROM cache WHERE key = 'sleeper_players'").get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, SleeperPlayer> : null;
}

export function getSleeperCacheInfo(): { count: number; fetchedAt: string | null } {
  const row = db.prepare("SELECT value, fetched_at FROM cache WHERE key = 'sleeper_players'").get() as { value: string; fetched_at: string } | undefined;
  if (!row) return { count: 0, fetchedAt: null };
  try { return { count: Object.keys(JSON.parse(row.value) as object).length, fetchedAt: row.fetched_at }; }
  catch { return { count: 0, fetchedAt: row.fetched_at }; }
}

export function cachePlayers(players: Record<string, SleeperPlayer>): void {
  db.prepare(`INSERT INTO cache(key, value, fetched_at) VALUES('sleeper_players', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, fetched_at=excluded.fetched_at`)
    .run(JSON.stringify(players), new Date().toISOString());
}

export function saveAnalysis(result: AnalysisResult): void {
  db.prepare('INSERT OR REPLACE INTO analyses(id, value, analyzed_at) VALUES(?, ?, ?)')
    .run(result.id, JSON.stringify(result), result.analyzedAt);
  db.prepare('DELETE FROM analyses WHERE id NOT IN (SELECT id FROM analyses ORDER BY analyzed_at DESC LIMIT 20)').run();
}

export function getLatestAnalysis(): AnalysisResult | null {
  const row = db.prepare('SELECT value FROM analyses ORDER BY analyzed_at DESC LIMIT 1').get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) as AnalysisResult : null;
}

export function listAnalysisHistory(limit = 10): AnalysisHistoryItem[] {
  const rows = db.prepare('SELECT id, value, analyzed_at FROM analyses ORDER BY analyzed_at DESC LIMIT ?').all(limit) as Array<{ id: string; value: string; analyzed_at: string }>;
  return rows.map(row => {
    const value = JSON.parse(row.value) as AnalysisResult;
    return {
      id: row.id,
      analyzedAt: row.analyzed_at,
      season: value.season,
      week: value.week,
      currentProjected: value.rosterAnalysis.currentProjected ?? null,
      recommendedProjected: value.rosterAnalysis.totalProjected,
      expectedImprovement: value.rosterAnalysis.expectedWeeklyImprovement ?? null,
      provider: value.provider,
      coverage: value.rosterAnalysis.projectionCoverage ?? 0,
      transactionCount: value.transactions.length
    };
  });
}

export function getProviderCache<T>(source: string, cacheKey: string, maxAgeMs: number): { value: T; retrievedAt: string } | null {
  const row = db.prepare('SELECT value, retrieved_at FROM provider_cache WHERE source = ? AND cache_key = ?').get(source, cacheKey) as { value: string; retrieved_at: string } | undefined;
  if (!row || Date.now() - Date.parse(row.retrieved_at) >= maxAgeMs) return null;
  return { value: JSON.parse(row.value) as T, retrievedAt: row.retrieved_at };
}

export function putProviderCache(source: string, cacheKey: string, value: unknown, season?: string, week?: number): string {
  const retrievedAt = new Date().toISOString();
  db.prepare(`INSERT INTO provider_cache(source, cache_key, season, week, value, retrieved_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(source, cache_key) DO UPDATE SET season=excluded.season, week=excluded.week, value=excluded.value, retrieved_at=excluded.retrieved_at`)
    .run(source, cacheKey, season || null, week ?? null, JSON.stringify(value), retrievedAt);
  return retrievedAt;
}

export function clearProviderCache(source?: string): void {
  if (source) db.prepare('DELETE FROM provider_cache WHERE source = ?').run(source);
  else db.prepare('DELETE FROM provider_cache').run();
}

export function getLatestProviderRefresh(source: string): string | null {
  const row = db.prepare('SELECT MAX(retrieved_at) AS retrieved_at FROM provider_cache WHERE source = ?').get(source) as { retrieved_at: string | null };
  return row.retrieved_at;
}

export function getPlayerMappings(provider: string): PlayerMappingRow[] {
  return db.prepare('SELECT * FROM player_mappings WHERE provider = ?').all(provider) as PlayerMappingRow[];
}

export function upsertPlayerMapping(mapping: Omit<PlayerMappingRow, 'last_verified_at'>): void {
  db.prepare(`INSERT INTO player_mappings(provider, sleeper_player_id, provider_player_id, match_method, confidence, last_verified_at)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, sleeper_player_id) DO UPDATE SET provider_player_id=excluded.provider_player_id, match_method=excluded.match_method,
      confidence=excluded.confidence, last_verified_at=excluded.last_verified_at`)
    .run(mapping.provider, mapping.sleeper_player_id, mapping.provider_player_id, mapping.match_method, mapping.confidence, new Date().toISOString());
}

export function deletePlayerMapping(provider: string, sleeperPlayerId: string): void {
  db.prepare('DELETE FROM player_mappings WHERE provider = ? AND sleeper_player_id = ?').run(provider, sleeperPlayerId);
}

export function closeDb(): void { db.close(); }
