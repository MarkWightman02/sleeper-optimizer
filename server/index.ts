import compression from 'compression';
import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ProgressEvent } from '../shared/types.js';
import { clearConfig, clearProviderCache, getConfig, getLatestAnalysis, listAnalysisHistory, saveAnalysis, saveConfig } from './db.js';
import { runAnalysis } from './engine/analysis.js';
import { sleeperApi, UpstreamError } from './services/sleeper.js';

const app = express();
const port = Number(process.env.PORT || 8009);
const host = process.env.HOST || '0.0.0.0';

app.disable('x-powered-by');
app.use(compression());
app.use(cors({ origin: false }));
app.use(express.json({ limit: '64kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://sleepercdn.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  next();
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/config', (_req, res) => res.json({ configured: Boolean(getConfig()), config: getConfig() }));
app.get('/api/analysis/latest', (_req, res) => res.json({ analysis: getLatestAnalysis() }));
app.get('/api/analysis/history', (_req, res) => res.json({ history: listAnalysisHistory(20) }));
app.get('/api/diagnostics', (_req, res) => {
  const analysis = getLatestAnalysis();
  res.json({ diagnostics: analysis?.diagnostics || null });
});
app.delete('/api/cache/external', (_req, res) => {
  clearProviderCache();
  res.status(204).end();
});

app.post('/api/setup/discover', async (req, res, next) => {
  try {
    const { username } = z.object({ username: z.string().trim().min(1).max(80) }).parse(req.body);
    const [state, user] = await Promise.all([sleeperApi.getState(), sleeperApi.getUser(username)]);
    if (!user?.user_id) return res.status(404).json({ error: 'No Sleeper user was found for that username.' });
    const leagues = (await sleeperApi.getUserLeagues(user.user_id, state.season)).filter(league => league.status !== 'complete' || league.season === state.season);
    if (!leagues.length) return res.status(404).json({ error: `No NFL fantasy leagues were found for ${state.season}.` });
    res.json({ user, season: state.season, leagues });
  } catch (error) { next(error); }
});

app.post('/api/setup/save', async (req, res, next) => {
  try {
    const body = z.object({ username: z.string().min(1), userId: z.string().min(1), leagueId: z.string().min(1), season: z.string().min(4) }).parse(req.body);
    const [league, rosters] = await Promise.all([sleeperApi.getLeague(body.leagueId), sleeperApi.getRosters(body.leagueId)]);
    if (!rosters.some(roster => roster.owner_id === body.userId)) return res.status(400).json({ error: 'That Sleeper user does not own a roster in this league.' });
    const config = { ...body, leagueName: league.name };
    saveConfig(config);
    res.json({ config });
  } catch (error) { next(error); }
});

app.delete('/api/config', (_req, res) => { clearConfig(); res.status(204).end(); });

interface Job { events: ProgressEvent[]; listeners: Set<(event: ProgressEvent) => void>; running: boolean }
const jobs = new Map<string, Job>();

app.post('/api/optimize', (req, res) => {
  const config = getConfig();
  if (!config) return res.status(409).json({ error: 'Complete setup before running an optimization.' });
  const { forceRefresh } = z.object({ forceRefresh: z.boolean().optional() }).parse(req.body || {});
  const id = crypto.randomUUID();
  const job: Job = { events: [], listeners: new Set(), running: true };
  jobs.set(id, job);
  const publish = (event: ProgressEvent) => { job.events.push(event); for (const listener of job.listeners) listener(event); };
  res.status(202).json({ jobId: id });
  setImmediate(async () => {
    try { saveAnalysis(await runAnalysis(config, publish, { forceRefresh })); }
    catch (error) { publish({ stage: 'error', message: 'Optimization failed.', done: true, error: error instanceof Error ? error.message : 'Unexpected optimization error' }); }
    finally {
      job.running = false;
      setTimeout(() => jobs.delete(id), 30 * 60 * 1000).unref();
    }
  });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Optimization job not found or expired.' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (event: ProgressEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  for (const event of job.events) send(event);
  if (!job.running) return res.end();
  job.listeners.add(send);
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15_000);
  req.on('close', () => { clearInterval(heartbeat); job.listeners.delete(send); });
});

const dist = path.join(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*splat', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues[0]?.message || 'Invalid request.' });
  if (error instanceof UpstreamError) return res.status(error.status === 404 ? 404 : 502).json({ error: error.message, service: error.service });
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected server error.' });
});

const server = app.listen(port, host, () => console.log(`Sleeper Optimizer listening on http://${host}:${port}`));
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
