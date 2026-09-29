import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, ArrowUp, Check, ChevronDown, CircleHelp, Clock3, Database, Gauge, Link2, ListFilter, Menu, RefreshCw, Settings, ShieldCheck, SlidersHorizontal, Swords, Trophy, Users, X } from 'lucide-react';
import type { AnalysisHistoryItem, AnalysisResult, AppConfig, LineupDecision, LineupEntry, MatchupTeamLine, PlayerEvaluation, ProgressEvent, SleeperLeague, SleeperUser, TransactionRecommendation, TransactionSummary } from '../shared/types';

type Tab = 'overview' | 'team' | 'agents' | 'league' | 'matchup' | 'settings';

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body as T;
}

function StatusBadge({ player }: { player: PlayerEvaluation }) {
  const warning = ['Questionable', 'Doubtful', 'Out', 'IR', 'Inactive'].includes(player.injuryStatus || '');
  return <span className={`status ${warning ? 'status-warn' : player.eligible ? 'status-ok' : 'status-muted'}`}><span />{player.injuryStatus || player.status || 'Active'}</span>;
}

function Points({ value }: { value: number | null }) {
  return value == null ? <span className="muted">—</span> : <strong className="points">{value.toFixed(1)}</strong>;
}

function Why({ reasons, metrics }: { reasons: string[]; metrics?: PlayerEvaluation['metrics'] }) {
  return <details className="why"><summary><CircleHelp size={14} /> Why?</summary><div className="why-body"><ul>{reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{metrics && <div className="sources">{Object.entries(metrics).filter(([, metric]) => metric.value != null).map(([name, metric]) => <span key={name}>{name}: {metric.source}</span>)}</div>}</div></details>;
}

const fmt = (value: number | null | undefined) => value == null ? 'unavailable' : value.toFixed(1);
const fmtTime = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString() : 'not reported';
const KIND_LABEL: Record<LineupDecision['kind'], string> = { PROJECTION: 'PROJECTION', CLOSE_CALL: 'CLOSE CALL', TOSS_UP: 'TOSS-UP', AVAILABILITY_EXCLUSION: 'AVAILABILITY OVERRIDE', AVAILABILITY_DISCOUNT: 'AVAILABILITY OVERRIDE', NO_PROJECTION: 'NO PROJECTION' };

function DecisionWhy({ decision, metrics }: { decision: LineupDecision; metrics?: PlayerEvaluation['metrics'] }) {
  const availability = decision.benchAvailability;
  const override = decision.kind === 'AVAILABILITY_EXCLUSION' || decision.kind === 'AVAILABILITY_DISCOUNT';
  const news = availability?.latestNews;
  return <details className="why" open={override}><summary><CircleHelp size={14} /> Why?</summary><div className="why-body decision-why">
    <h4>Recommendation</h4><p><strong>{decision.headline}</strong></p>
    <h4>Projection</h4>
    <dl className="mini-dl"><div><dt>{decision.startName} (start)</dt><dd>{fmt(decision.startProjection)}</dd></div><div><dt>{decision.benchName} ({override ? 'benched, if healthy' : 'bench'})</dt><dd>{fmt(decision.benchProjection)}</dd></div><div><dt>Difference (start − bench)</dt><dd>{decision.difference == null ? 'unavailable' : `${decision.difference >= 0 ? '+' : ''}${decision.difference.toFixed(2)}`}</dd></div>{override && <div><dt>Projection sacrifice</dt><dd className="warn-text">{fmt(decision.projectionSacrifice)}</dd></div>}<div><dt>Availability-weighted expected</dt><dd>{fmt(decision.startExpected)} vs {fmt(decision.benchExpected)}</dd></div></dl>
    {decision.whyLowerProjection && <><h4>Why recommend the lower projection?</h4><p>{decision.whyLowerProjection}</p></>}
    {availability && <><h4>Injury / availability — {decision.benchName}</h4>
      <dl className="mini-dl"><div><dt>Status</dt><dd>{availability.status}{availability.rawStatus && availability.rawStatus !== availability.status ? ` (${availability.rawStatus})` : ''} · risk {availability.riskFlag}</dd></div><div><dt>Injury</dt><dd>{availability.injury || 'not reported'}{availability.practice ? ` · practice: ${availability.practice}` : ''}</dd></div><div><dt>Latest update</dt><dd>{news ? <>{news.headline}<small>{news.source} · {fmtTime(news.publishedAt)} · read as {news.signal.toLowerCase()}</small></> : 'No news item found'}</dd></div><div><dt>Source</dt><dd>{availability.statusSource}{availability.sourceStale ? ' — STALE fallback' : ''}</dd></div><div><dt>Status updated</dt><dd>{fmtTime(availability.statusUpdatedAt)}</dd></div><div><dt>Retrieved</dt><dd>{fmtTime(availability.retrievedAt)}</dd></div><div><dt>Confidence</dt><dd>{availability.confidence}<small>{availability.confidenceReasons.join('; ')}</small></dd></div><div><dt>Play estimate</dt><dd>{Math.round(availability.playProbability * 100)}%<small>{availability.policy}</small></dd></div></dl></>}
    <h4>Decision logic</h4><ul>{decision.decisionLogic.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <h4>What could change this?</h4><ul>{decision.whatCouldChange.map((line, index) => <li key={index}>{line}</li>)}</ul>
    {metrics && <div className="sources">{Object.entries(metrics).filter(([, metric]) => metric.value != null).map(([name, metric]) => <span key={name}>{name}: {metric.source}</span>)}</div>}
  </div></details>;
}

function Setup({ onSaved, existing, onCancel }: { onSaved: (config: AppConfig) => void; existing?: AppConfig | null; onCancel?: () => void }) {
  const [username, setUsername] = useState(existing?.username || '');
  const [found, setFound] = useState<{ user: SleeperUser; season: string; leagues: SleeperLeague[] } | null>(null);
  const [leagueId, setLeagueId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const discover = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api<{ user: SleeperUser; season: string; leagues: SleeperLeague[] }>('/api/setup/discover', { method: 'POST', body: JSON.stringify({ username }) });
      setFound(result); setLeagueId(result.leagues.length === 1 ? result.leagues[0].league_id : existing?.leagueId || '');
    } catch (err) { setError(err instanceof Error ? err.message : 'Setup failed.'); }
    finally { setBusy(false); }
  };

  const save = async () => {
    if (!found || !leagueId) return;
    setBusy(true); setError('');
    try {
      const result = await api<{ config: AppConfig }>('/api/setup/save', { method: 'POST', body: JSON.stringify({ username: found.user.username, userId: found.user.user_id, leagueId, season: found.season }) });
      onSaved(result.config);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save configuration.'); }
    finally { setBusy(false); }
  };

  return <main className="setup-shell">
    <section className="setup-card">
      <div className="brand-mark">SO</div>
      <p className="eyebrow">READ-ONLY SLEEPER ANALYTICS</p>
      <h1>{existing ? 'Change league' : 'Connect your league'}</h1>
      <p className="setup-copy">Enter your Sleeper username. No password or Sleeper write access is needed.</p>
      <form onSubmit={discover} className="setup-form">
        <label htmlFor="username">Sleeper username</label>
        <div className="input-action"><input id="username" value={username} onChange={event => setUsername(event.target.value)} placeholder="your_username" autoComplete="username" required /><button className="button secondary" disabled={busy}>{busy ? <RefreshCw className="spin" size={17} /> : 'Find leagues'}</button></div>
      </form>
      {error && <div className="error-box"><AlertTriangle size={18} />{error}</div>}
      {found && <div className="league-picker">
        <div className="picker-title"><Check size={17} /> Found {found.leagues.length} league{found.leagues.length === 1 ? '' : 's'} for {found.season}</div>
        <label htmlFor="league">League</label>
        <select id="league" value={leagueId} onChange={event => setLeagueId(event.target.value)}>
          <option value="" disabled>Choose a league</option>
          {found.leagues.map(league => <option key={league.league_id} value={league.league_id}>{league.name} · {league.total_rosters} teams</option>)}
        </select>
        <button className="button primary full" disabled={!leagueId || busy} onClick={save}>Use this league</button>
      </div>}
      {onCancel && <button className="text-button" onClick={onCancel}>Cancel</button>}
      <div className="privacy-note"><ShieldCheck size={18} /><span>Sleeper Optimizer only reads public league data. It cannot change your lineup or roster.</span></div>
    </section>
  </main>;
}

function LineupTable({ entries }: { entries: LineupEntry[] }) {
  return <div className="table-wrap"><table><thead><tr><th>Slot</th><th>Player</th><th>Matchup</th><th>Status</th><th>Proj.</th><th>Confidence</th><th>Decision</th></tr></thead><tbody>
    {entries.map((entry, index) => {
      const player = entry.player; const decision = entry.decision;
      if (!player) return <tr key={`${entry.slot}-${index}`}><td><span className="slot">{entry.slot}</span></td><td colSpan={6} className="danger-text">No eligible player</td></tr>;
      return <tr key={`${entry.slot}-${index}`} className={entry.changed ? 'changed-row' : ''}>
        <td><span className="slot">{entry.slot}</span></td><td><div className="player-cell"><strong>{player.name}</strong><span>{player.positions.join('/')} · {player.team || 'FA'}</span></div></td>
        <td>{player.opponent ? `${player.opponent}` : <span className="muted">—</span>}<small>{player.gameTime ? new Date(player.gameTime).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''}</small></td>
        <td><StatusBadge player={player} /></td><td><Points value={player.weeklyPoints} /></td><td>{player.confidence}</td>
        <td>{entry.changed ? <><span className={`decision start ${decision && decision.kind.startsWith('AVAILABILITY') ? 'override' : ''}`}><ArrowUp size={14} /> START</span>{decision && <small>{KIND_LABEL[decision.kind]} · over {decision.benchName}{decision.difference != null ? ` (${decision.difference >= 0 ? '+' : ''}${decision.difference !== 0 && Math.abs(decision.difference) < 0.1 ? decision.difference.toFixed(2) : decision.difference.toFixed(1)} proj.)` : ''}</small>}</> : <span className="muted">Keep</span>}{decision ? <DecisionWhy decision={decision} metrics={player.metrics} /> : <Why reasons={player.reasons} metrics={player.metrics} />}</td>
      </tr>;
    })}
  </tbody></table></div>;
}

const tierClass = (tier?: string) => `tier-${(tier || 'HOLD').toLowerCase().replace(' ', '-')}`;
const signedPoints = (value: number | null | undefined) => value == null ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(1)}`;
const ACQUISITION_LABEL = { WAIVER_CLAIM: 'Waiver claim', FREE_AGENT: 'Free-agent add', UNKNOWN: 'Waiver status unverified' } as const;

function TransactionSections({ tx }: { tx: TransactionRecommendation }) {
  const sections = tx.assessment?.sections;
  return <details className="why"><summary><CircleHelp size={14} /> Why?</summary><div className="why-body wide">{sections ? <dl className="why-sections">{sections.map(section => <div key={section.label}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl> : <ul>{tx.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</div></details>;
}

function TransactionCard({ tx, recommended }: { tx: TransactionRecommendation; recommended: boolean }) {
  const a = tx.assessment;
  return <article className={`transaction ${recommended ? '' : 'transaction-considered'}`}>
    <div className="move-pair"><div><span className="move-label add">ADD</span><strong>{tx.add.name}</strong><small>{tx.add.positions.join('/')} · {tx.add.team} · {ACQUISITION_LABEL[tx.acquisition || 'UNKNOWN']}</small></div><div className="swap-line" /><div><span className="move-label drop">DROP</span><strong>{tx.drop.name}</strong><small>{tx.drop.positions.join('/')} · {tx.drop.team}{a ? ` · drop cost ${a.drop.cost.toFixed(1)}` : ''}</small></div></div>
    <div className="impact"><span><small>Weekly gain</small><strong>{signedPoints(tx.weeklyGain)}</strong></span><span><small>Waiver cost</small><strong>{a ? (a.waiver.cost > 0 ? `−${a.waiver.cost.toFixed(1)}` : 'None') : '—'}</strong></span><span><small>Long-term</small><strong>{a ? (a.longTerm.status === 'AVAILABLE' ? signedPoints(a.longTerm.rosGainPerWeek) + '/wk' : 'Insufficient') : 'Unavailable'}</strong></span><span><small>Confidence</small><strong>{tx.confidence}</strong></span><span><small>Net</small><strong>{a ? signedPoints(a.net) : '—'}</strong></span><span><small>Tier</small><strong className={`tier ${tierClass(tx.tier)}`}>{tx.tier || 'HOLD'}</strong></span></div>
    <TransactionSections tx={tx} />
  </article>;
}

function Transactions({ transactions, considered = [], summary }: { transactions: TransactionRecommendation[]; considered?: TransactionRecommendation[]; summary?: TransactionSummary }) {
  const rules = summary?.waiverRules;
  return <section className="panel"><div className="section-head"><div><p className="eyebrow">WAIVER REVIEW</p><h2>Recommended Transactions</h2></div><span className="count-chip">{transactions.length ? `${transactions.length} move${transactions.length === 1 ? '' : 's'}` : 'HOLD'}</span></div>
    {rules && <p className="fine-print">{rules.type === 'ROLLING' ? 'Rolling waivers' : rules.type === 'FAAB' ? 'FAAB waivers' : rules.type === 'REVERSE_STANDINGS' ? 'Reverse-standings waivers' : 'Waiver type unknown'}{rules.priorityPosition != null ? ` · you are #${rules.priorityPosition} of ${rules.teams}` : ''}{rules.clearDays != null ? ` · ${rules.clearDays}-day waiver window` : ''}. A successful claim spends priority, so holding is the default.</p>}
    {!transactions.length ? <div className="empty-good"><ShieldCheck size={22} /><div><strong>{summary?.headline || 'No waiver claim recommended.'}</strong><p>{summary?.why || 'Your current roster is stronger than the supported available alternatives.'}</p></div></div> : <div className="transaction-list">{transactions.map(tx => <TransactionCard key={`${tx.add.playerId}-${tx.drop.playerId}`} tx={tx} recommended />)}</div>}
    {considered.length > 0 && <details className="considered"><summary>Show {considered.length} alternatives evaluated and not recommended</summary><div className="transaction-list">{considered.map(tx => <TransactionCard key={`${tx.add.playerId}:${tx.drop.playerId}`} tx={tx} recommended={false} />)}</div></details>}
  </section>;
}

function AvailabilityImpact({ analysis }: { analysis: AnalysisResult }) {
  const roster = analysis.rosterAnalysis;
  if (roster.pureProjectionTotal == null || !roster.pureProjectionLineup) return null;
  const sacrifice = roster.projectionSacrificeForAvailability ?? 0;
  const pureIds = new Set(roster.pureProjectionLineup.map(entry => entry.player?.playerId));
  const recIds = new Set(analysis.recommendedLineup.map(entry => entry.player?.playerId));
  const dropped = roster.pureProjectionLineup.filter(entry => entry.player && !recIds.has(entry.player.playerId));
  const added = analysis.recommendedLineup.filter(entry => entry.player && !pureIds.has(entry.player.playerId));
  return <section className="panel availability-panel"><div className="section-head"><div><p className="eyebrow">PROJECTION VS. AVAILABILITY</p><h2>Best lineup if everyone plays vs. recommended lineup</h2></div><span className={`count-chip ${sacrifice > 0.05 ? 'tier-marginal' : ''}`}>{sacrifice > 0.05 ? `Availability costs ${sacrifice.toFixed(1)} projected pts` : 'No availability cost'}</span></div>
    <div className="summary-strip four"><div><small>Pure projection</small><strong>{roster.pureProjectionTotal.toFixed(1)}</strong><span>everyone plays</span></div><div><small>Recommendation</small><strong>{roster.recommendedProjectionTotal == null ? '—' : roster.recommendedProjectionTotal.toFixed(1)}</strong><span>after availability</span></div><div><small>Projection sacrifice</small><strong className={sacrifice > 0.05 ? 'warn-text' : ''}>{sacrifice.toFixed(1)}</strong><span>published pts</span></div><div><small>Expected total</small><strong>{roster.recommendedExpectedTotal == null ? '—' : roster.recommendedExpectedTotal.toFixed(1)}</strong><span>projection × play %</span></div></div>
    {dropped.length > 0 ? <div className="considered-list">{dropped.map(entry => { const availability = entry.player!.availability; const replacement = added.find(other => other.slot === entry.slot) || added[dropped.indexOf(entry)]; return <div key={entry.player!.playerId}><span className="tier tier-marginal">{availability?.riskFlag || 'AVAILABILITY'}</span><strong>{entry.player!.name} ({fmt(entry.player!.weeklyPoints)})</strong><span>{availability ? `${availability.status} · ${availability.confidence} confidence · ${Math.round(availability.playProbability * 100)}% play estimate · ${availability.statusSource}, updated ${fmtTime(availability.statusUpdatedAt)}` : ''}</span>{replacement?.player && <span>replaced by {replacement.player.name} ({fmt(replacement.player.weeklyPoints)})</span>}</div>; })}</div> : <p className="fine-print">Every player in the pure-projection lineup is also in the recommended lineup.</p>}
    <p className="fine-print">Published projections are never edited for injuries. Availability is a separate field that the lineup solver uses only through a documented play-probability rule.</p></section>;
}

function Overview({ analysis }: { analysis: AnalysisResult }) {
  const total = analysis.rosterAnalysis.totalProjected;
  const current = analysis.rosterAnalysis.currentProjected ?? null;
  const changes = analysis.recommendedLineup.filter(entry => entry.changed).length;
  const gain = analysis.rosterAnalysis.expectedWeeklyImprovement ?? null;
  const coverage = analysis.rosterAnalysis.projectionCoverage ?? analysis.diagnostics?.projectionCoverage ?? 0;
  const diff = analysis.matchupAnalysis?.difference ?? null;
  return <div className="page-stack">
    {analysis.weekSelection && <div className={`week-banner${analysis.weekSelection.advanced ? ' advanced' : ''}`}>
      <div><small>TARGET WEEK</small><strong>Optimizing Week {analysis.weekSelection.targetWeek}</strong></div>
      <div>
        {analysis.weekSelection.advanced && <p><strong>{analysis.weekSelection.message}</strong></p>}
        <p>Sleeper week: {analysis.weekSelection.sleeperWeek} · Reason: {analysis.weekSelection.reason}</p>
        <p>Analysis timestamp: {new Date(analysis.analyzedAt).toLocaleString()}{analysis.weekSelection.relevantGames.nextKickoff ? ` · Next relevant kickoff: ${new Date(analysis.weekSelection.relevantGames.nextKickoff).toLocaleString()}` : ''}</p>
        {!analysis.weekSelection.matchupAvailable && analysis.weekSelection.matchupNote && <p className="muted">{analysis.weekSelection.matchupNote}</p>}
      </div>
    </div>}
    {analysis.warnings.map((warning, index) => <div className="warning" key={index}><AlertTriangle size={18} /><span>{warning}</span></div>)}
    <div className="timing-strip">
      <span><Clock3 size={14} /> Analysis started: {new Date(analysis.analysisStartedAt).toLocaleString()}</span>
      <span><Clock3 size={14} /> Data retrieved through: {analysis.dataThroughAt ? new Date(analysis.dataThroughAt).toLocaleString() : 'unavailable'}</span>
      <span>Sources: {analysis.diagnostics?.sourcesSuccessful ?? 0}/{analysis.diagnostics?.sourcesAttempted ?? 0} succeeded</span>
    </div>
    <div className="summary-strip"><div><small>Recommended projection</small><strong>{total == null ? '—' : total.toFixed(1)}</strong><span>Week {analysis.week}</span></div><div><small>Current lineup</small><strong>{current == null ? '—' : current.toFixed(1)}</strong><span>{changes} suggested change{changes === 1 ? '' : 's'}</span></div><div><small>Expected gain</small><strong>{gain == null ? '—' : `${gain >= 0 ? '+' : ''}${gain.toFixed(1)}`}</strong><span>points this week</span></div><div><small>Opponent projection</small><strong>{analysis.matchupAnalysis?.opponentProjected == null ? '—' : analysis.matchupAnalysis.opponentProjected.toFixed(1)}</strong><span>{analysis.matchupAnalysis?.opponentName || 'No matchup found'}</span></div><div><small>Projected difference</small><strong className={diff != null && diff < 0 ? 'danger-text' : ''}>{diff == null ? '—' : `${diff >= 0 ? '+' : ''}${diff.toFixed(1)}`}</strong><span>vs. this week's opponent</span></div><div><small>Projection coverage</small><strong>{coverage}%</strong><span>{analysis.provider || 'Sleeper only'}</span></div><div><small>Free agents reviewed</small><strong>{analysis.freeAgents.length}</strong><span>unowned players</span></div></div>
    <AvailabilityImpact analysis={analysis} />
    <section className="panel"><div className="section-head"><div><p className="eyebrow">RECOMMENDED AFTER AVAILABILITY</p><h2>Recommended Lineup — Week {analysis.week}</h2></div><span className="timestamp"><Clock3 size={14} /> {new Date(analysis.analyzedAt).toLocaleString()}</span></div><LineupTable entries={analysis.recommendedLineup} /></section>
    <Transactions transactions={analysis.transactions} considered={analysis.consideredTransactions} summary={analysis.transactionSummary} />
    <section className="panel provenance"><div className="section-head"><div><p className="eyebrow">AUDIT TRAIL</p><h2>Data Provenance</h2></div></div><div className="provenance-grid">{Object.entries(analysis.provenance).map(([name, source]) => <div key={name}><span>{name.replace(/([A-Z])/g, ' $1')}</span><strong>{source}</strong></div>)}</div></section>
  </div>;
}

function Matchup({ analysis }: { analysis: AnalysisResult }) {
  const matchup = analysis.matchupAnalysis;
  if (!matchup) return <div className="page-stack"><div className="empty-good"><Swords size={22} /><div><strong>No Week {analysis.week} opponent is available.</strong><p>{analysis.weekSelection?.matchupNote || 'This can happen on a bye week, in the playoffs, or before the league\'s schedule is set.'}</p></div></div></div>;
  const row = (mine?: MatchupTeamLine, theirs?: MatchupTeamLine) => <tr key={`${mine?.slot}-${theirs?.slot}`}>
    <td>{mine ? <><strong>{mine.name}</strong><small>{mine.positions.join('/')} · {mine.team || 'FA'} vs {mine.opponent || '—'}</small></> : <span className="muted">—</span>}</td>
    <td><Points value={mine?.weeklyPoints ?? null} /></td>
    <td>{mine?.status || 'Active'} · {mine?.confidence}</td>
    <td><span className="slot">{mine?.slot || theirs?.slot}</span></td>
    <td>{theirs?.status || 'Active'} · {theirs?.confidence}</td>
    <td><Points value={theirs?.weeklyPoints ?? null} /></td>
    <td>{theirs ? <><strong>{theirs.name}</strong><small>{theirs.positions.join('/')} · {theirs.team || 'FA'} vs {theirs.opponent || '—'}</small></> : <span className="muted">—</span>}</td>
  </tr>;
  const rows = Math.max(matchup.myLineup.length, matchup.opponentLineup.length);
  return <div className="page-stack">
    <section className="panel"><div className="section-head"><div><p className="eyebrow">WEEK {analysis.week} MATCHUP</p><h2>You vs. {matchup.opponentName}</h2></div><span className={`count-chip ${(matchup.difference ?? 0) < 0 ? 'tier-hold' : ''}`}>{matchup.difference == null ? 'Incomplete' : `${matchup.difference >= 0 ? '+' : ''}${matchup.difference.toFixed(1)} projected`}</span></div>
      <div className="table-wrap"><table><thead><tr><th>You</th><th>Proj.</th><th>Status</th><th>Slot</th><th>Status</th><th>Proj.</th><th>Opponent</th></tr></thead><tbody>
        {Array.from({ length: rows }, (_, index) => row(matchup.myLineup[index], matchup.opponentLineup[index]))}
      </tbody></table></div>
    </section>
    <section className="panel"><div className="section-head"><div><p className="eyebrow">STACKS & INTERACTIONS</p><h2>Correlation Analysis</h2></div></div>
      {matchup.correlations.length ? <div className="considered-list">{matchup.correlations.map((note, index) => <div key={index}><span className="tier tier-upgrade"><Link2 size={13} /> {note.relationship}</span><strong>{note.myPlayerName}</strong><span>↔ {note.opponentPlayerName} ({note.team})</span><p className="fine-print">{note.explanation}</p></div>)}</div> : <p className="fine-print">No same-team QB/pass-catcher or defense/offense relationships were found between the two lineups this week.</p>}
    </section>
  </div>;
}

function MyTeam({ analysis }: { analysis: AnalysisResult }) {
  return <div className="page-stack"><section className="panel"><div className="section-head"><div><p className="eyebrow">SIDE-BY-SIDE</p><h2>Current vs. Recommended</h2></div></div><div className="comparison">
    <div><h3>Current</h3><LineupTable entries={analysis.currentLineup} /></div><div><h3>Recommended</h3><LineupTable entries={analysis.recommendedLineup} /></div>
  </div></section><section className="panel"><div className="section-head"><div><p className="eyebrow">ROSTER DEPTH</p><h2>Bench, IR & Taxi</h2></div><p>{analysis.rosterAnalysis.summary}</p></div><div className="roster-groups"><PlayerList title="Bench" players={analysis.bench} /><PlayerList title="Reserve / IR" players={analysis.reserve} /><PlayerList title="Taxi" players={analysis.taxi} /></div></section></div>;
}

function PlayerList({ title, players }: { title: string; players: PlayerEvaluation[] }) {
  return <div className="player-list"><h3>{title} <span>{players.length}</span></h3>{players.length ? players.map(player => <div className="compact-player" key={player.playerId}><div><strong>{player.name}</strong><span>{player.positions.join('/')} · {player.team || 'FA'}</span></div><StatusBadge player={player} /><Points value={player.weeklyPoints} /></div>) : <p className="empty-text">No players</p>}</div>;
}

function FreeAgents({ analysis }: { analysis: AnalysisResult }) {
  const [position, setPosition] = useState('ALL'); const [sort, setSort] = useState('projection'); const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PlayerEvaluation | null>(null);
  const recommended = new Set(analysis.transactions.map(tx => tx.add.playerId));
  const addTiers = new Map([...analysis.transactions, ...(analysis.consideredTransactions || [])].map(tx => [tx.add.playerId, tx.tier]));
  const addScores = new Map([...analysis.transactions, ...(analysis.consideredTransactions || [])].map(tx => [tx.add.playerId, tx.score ?? -Infinity]));
  const positions = [...new Set(analysis.freeAgents.flatMap(player => player.positions))].sort();
  const players = useMemo(() => analysis.freeAgents.filter(player => (position === 'ALL' || player.positions.includes(position)) && player.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'position' ? (a.positions[0] || '').localeCompare(b.positions[0] || '') : sort === 'ros' ? (b.restOfSeasonValue ?? -Infinity) - (a.restOfSeasonValue ?? -Infinity) : sort === 'vor' ? (b.valueOverReplacement ?? -Infinity) - (a.valueOverReplacement ?? -Infinity) : sort === 'best' ? (addScores.get(b.playerId) ?? -Infinity) - (addScores.get(a.playerId) ?? -Infinity) || (b.weeklyPoints ?? -Infinity) - (a.weeklyPoints ?? -Infinity) : (b.weeklyPoints ?? -Infinity) - (a.weeklyPoints ?? -Infinity)), [analysis, position, query, sort]);
  const relatedMoves = selected ? [...analysis.transactions, ...(analysis.consideredTransactions || [])].filter(tx => tx.add.playerId === selected.playerId) : [];
  return <><section className="panel"><div className="section-head"><div><p className="eyebrow">VERIFIED UNROSTERED</p><h2>Free Agents</h2></div><span className="count-chip">{players.length} shown</span></div><div className="toolbar"><label className="search"><ListFilter size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter players" aria-label="Filter players" /></label><select value={position} onChange={event => setPosition(event.target.value)} aria-label="Position"><option value="ALL">All positions</option>{positions.map(item => <option key={item}>{item}</option>)}</select><select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort free agents"><option value="projection">Projected points</option><option value="ros">Rest of season</option><option value="vor">Value over replacement</option><option value="best">Best add</option><option value="position">Position</option><option value="name">Name</option></select></div>
    <div className="table-wrap"><table><thead><tr><th>Player</th><th>Pos.</th><th>Team</th><th>Opponent</th><th>Status</th><th>Projected</th><th>ROS value</th><th>VOR</th><th>Confidence</th><th>Recommendation</th></tr></thead><tbody>{players.map(player => <tr key={player.playerId} className={recommended.has(player.playerId) ? 'recommended-row clickable-row' : 'clickable-row'} onClick={() => setSelected(player)}><td><strong>{player.name}</strong><small>{player.playerId}</small></td><td>{player.positions.join('/')}</td><td>{player.team || '—'}</td><td>{player.opponent || '—'}</td><td><StatusBadge player={player} /></td><td><Points value={player.weeklyPoints} /></td><td><Points value={player.restOfSeasonValue} /></td><td><Points value={player.valueOverReplacement ?? null} /></td><td>{player.confidence}<small>{player.projectionCoverage ?? 0}% coverage</small></td><td>{recommended.has(player.playerId) ? <span className="decision start"><ArrowUp size={14} /> {addTiers.get(player.playerId) || 'CLAIM'}</span> : <span className="muted">{addTiers.get(player.playerId) || 'Monitor'}</span>}<small>{player.acquisition ? ACQUISITION_LABEL[player.acquisition.kind] : ''}</small></td></tr>)}</tbody></table></div>
  </section>{selected && <div className="drawer-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSelected(null); }}><aside className="player-drawer" role="dialog" aria-modal="true" aria-labelledby="player-title"><button className="icon-button drawer-close" onClick={() => setSelected(null)} aria-label="Close player details"><X /></button><p className="eyebrow">PLAYER EVALUATION</p><h2 id="player-title">{selected.name}</h2><p className="drawer-subtitle">{selected.positions.join('/')} · {selected.team || 'Free agent'} · ESPN ID {selected.espnId || 'unmapped'}</p><div className="drawer-metrics"><div><small>Week</small><Points value={selected.weeklyPoints} /></div><div><small>ROS</small><Points value={selected.restOfSeasonValue} /></div><div><small>VOR</small><Points value={selected.valueOverReplacement ?? null} /></div><div><small>Coverage</small><strong>{selected.projectionCoverage ?? 0}%</strong></div></div><dl className="detail-list"><div><dt>Mapping</dt><dd>{selected.mappingConfidence || 'unmapped'}{selected.mappingMethod ? ` · ${selected.mappingMethod}` : ''}</dd></div><div><dt>Availability</dt><dd>{selected.availability?.status || selected.normalizedInjuryStatus || selected.injuryStatus || 'UNKNOWN'}{selected.practiceParticipation ? ` · ${selected.practiceParticipation}` : ''}</dd></div>{selected.availability && <><div><dt>Availability confidence</dt><dd>{selected.availability.confidence} · risk {selected.availability.riskFlag}</dd></div><div><dt>Play estimate</dt><dd>{Math.round(selected.availability.playProbability * 100)}% → expected {fmt(selected.expectedPoints)}</dd></div><div><dt>Status source</dt><dd>{selected.availability.statusSource}<small>updated {fmtTime(selected.availability.statusUpdatedAt)} · retrieved {fmtTime(selected.availability.retrievedAt)}</small></dd></div></>}<div><dt>Body part</dt><dd>{selected.injuryBodyPart || 'Not reported'}</dd></div></dl>
    <h3>Projections</h3>{selected.projections.length ? <div className="component-list">{selected.projections.map((p, i) => <div key={i}><span>{p.source}</span><span /><span /><strong>{p.points.toFixed(1)}</strong></div>)}<div className="consensus-row"><span>Consensus ({selected.projections.length} source{selected.projections.length === 1 ? '' : 's'})</span><strong>{selected.weeklyPoints?.toFixed(1)}</strong></div></div> : <p className="fine-print">No projection source covered this player. No points were fabricated.</p>}
    <h3>Rankings</h3>{selected.rankings.length ? <div className="component-list">{selected.rankings.map((r, i) => <div key={i}><span>{r.source}</span><span>{r.scoringType}</span><span /><strong>#{r.positionRank}</strong></div>)}</div> : <p className="fine-print">No published ranking is available for this player.</p>}
    <h3>News</h3>{selected.newsItems.length ? <div className="news-list">{selected.newsItems.map((n, i) => <div key={i}><strong>{n.headline}</strong>{n.summary && <p>{n.summary}</p>}<small>{n.source}{n.publishedAt ? ` · ${new Date(n.publishedAt).toLocaleString()}` : ''}</small></div>)}</div> : <p className="fine-print">No recent news was found for this player.</p>}
    <h3>Scoring breakdown</h3>{selected.scoringComponents?.length ? <div className="component-list">{selected.scoringComponents.map((component, index) => <div key={`${component.providerStat}-${index}`} className={component.modeled ? '' : 'unmodeled'}><span>{component.providerStat}</span><span>{component.projectedStat == null ? '—' : component.projectedStat}</span><span>{component.sleeperKey || 'unsupported'}</span><strong>{component.projectedPoints == null ? '—' : `${component.projectedPoints >= 0 ? '+' : ''}${component.projectedPoints.toFixed(2)}`}</strong></div>)}</div> : <p className="fine-print">No provider projection is available. No scoring components were fabricated.</p>}<h3>Potential roster impact</h3>{relatedMoves.length ? <><div className="drawer-moves">{relatedMoves.map(tx => <div key={tx.drop.playerId}><span className={`tier ${tierClass(tx.tier)}`}>{tx.tier || 'HOLD'}</span><strong>Drop {tx.drop.name}</strong><span>{tx.weeklyGain == null ? 'Unknown weekly impact' : `${tx.weeklyGain >= 0 ? '+' : ''}${tx.weeklyGain.toFixed(1)} weekly lineup points`}</span></div>)}</div>{relatedMoves[0].resultingLineup?.length ? <details className="resulting-lineup"><summary>Show resulting optimized lineup</summary>{relatedMoves[0].resultingLineup.map((entry, index) => <div key={`${entry.slot}-${index}`}><span className="slot">{entry.slot}</span><strong>{entry.player?.name || 'Unfilled'}</strong><Points value={entry.player?.weeklyPoints ?? null} /></div>)}</details> : null}</> : <p className="fine-print">No add/drop involving this player was evaluated as worth a transaction. Holding is the default under rolling waivers.</p>}</aside></div>}</>;
}

function League({ analysis }: { analysis: AnalysisResult }) {
  const teams = [...analysis.leagueTeams].sort((a, b) => (b.projectedPoints ?? -Infinity) - (a.projectedPoints ?? -Infinity));
  return <section className="panel"><div className="section-head"><div><p className="eyebrow">LEAGUE CONTEXT</p><h2>{analysis.league.name}</h2></div><span className="count-chip">{teams.length} teams</span></div><div className="league-list">{teams.map((team, index) => <details key={team.rosterId} className="team-row"><summary><span className="rank">{index + 1}</span><div><strong>{team.teamName}</strong><small>{team.owner}</small></div><div className="team-traits">{team.strengths.map(item => <span key={item}>{item}</span>)}</div><div className="team-projection"><small>Projected</small><Points value={team.projectedPoints} /></div><ChevronDown size={18} /></summary><div className="team-roster"><PlayerList title="Starters" players={team.starters} /><PlayerList title="Bench" players={team.bench} /><PlayerList title="IR / Taxi" players={[...team.reserve, ...team.taxi]} /></div></details>)}</div></section>;
}

function SettingsPage({ config, analysis, history, onChange, onForceRefresh, refreshing }: { config: AppConfig; analysis: AnalysisResult | null; history: AnalysisHistoryItem[]; onChange: () => void; onForceRefresh: () => void; refreshing: boolean }) {
  const diagnostics = analysis?.diagnostics;
  return <div className="settings-grid"><section className="panel"><p className="eyebrow">SLEEPER CONNECTION</p><h2>{config.leagueName}</h2><dl><div><dt>Username</dt><dd>{config.username}</dd></div><div><dt>Season</dt><dd>{config.season}</dd></div><div><dt>League ID</dt><dd>{config.leagueId}</dd></div></dl><button className="button secondary" onClick={onChange}><SlidersHorizontal size={17} /> Change league</button></section><section className="panel"><p className="eyebrow">FREE DATA SOURCES</p><h2>Source status</h2><dl><div><dt>Sleeper</dt><dd className={diagnostics?.sleeperStatus === 'Error' ? 'warn-text' : 'good'}>{diagnostics?.sleeperStatus || 'Connected'}</dd></div><div><dt>Sources succeeded</dt><dd className={diagnostics && diagnostics.sourcesSuccessful < diagnostics.sourcesAttempted ? 'warn-text' : 'good'}>{diagnostics?.sourcesSuccessful ?? 0} / {diagnostics?.sourcesAttempted ?? 0}</dd></div><div><dt>Season / week</dt><dd>{diagnostics ? `${diagnostics.season} / ${diagnostics.week}` : `${config.season} / —`}</dd></div><div><dt>Last Sleeper refresh</dt><dd>{diagnostics?.lastSleeperRefresh ? new Date(diagnostics.lastSleeperRefresh).toLocaleString() : 'Never'}</dd></div></dl>
    <div className="table-wrap"><table><thead><tr><th>Source</th><th>Kind</th><th>Status</th><th>Retrieved</th></tr></thead><tbody>{(diagnostics?.sources || []).map((source, index) => <tr key={`${source.name}-${index}`}><td>{source.name}</td><td>{source.kind}</td><td className={source.status === 'SUCCESS' && !source.stale ? 'good' : 'warn-text'}>{source.stale ? 'STALE CACHE' : source.status}{source.detail ? <small> · {source.detail}</small> : null}</td><td>{source.retrievedAt ? new Date(source.retrievedAt).toLocaleString() : '—'}</td></tr>)}</tbody></table></div>
    <button className="button secondary" onClick={onForceRefresh} disabled={refreshing}><RefreshCw size={17} className={refreshing ? 'spin' : ''} /> Force external refresh</button><p className="fine-print">No API keys are required. Every source above is a free, publicly accessible feed. Injury, news, projection and Sleeper-catalog data are re-fetched on every Optimize; an older cached copy is used only if the live fetch fails, and is then labelled STALE.</p></section>
  <section className="panel diagnostics"><div className="section-head"><div><p className="eyebrow">IDENTITY & COVERAGE</p><h2>Diagnostics</h2></div><span className="count-chip">{diagnostics?.projectionCoverage ?? 0}% coverage</span></div><div className="diagnostic-cards"><div><small>Sleeper players</small><strong>{diagnostics?.sleeperPlayersCached ?? 0}</strong></div><div><small>Mapped</small><strong>{diagnostics?.mapped ?? 0}</strong></div><div><small>Unmapped</small><strong>{diagnostics?.unmapped ?? 0}</strong></div><div><small>Ambiguous</small><strong>{diagnostics?.ambiguous ?? 0}</strong></div></div>{diagnostics?.unsupportedScoringKeys?.length ? <div className="warning compact"><AlertTriangle size={17} /><span>Unsupported scoring keys are excluded transparently: {diagnostics.unsupportedScoringKeys.join(', ')}</span></div> : null}<details className="mapping-details"><summary>Show mapping details</summary><div className="table-wrap"><table><thead><tr><th>Player</th><th>Team</th><th>Pos.</th><th>Status</th><th>Method</th></tr></thead><tbody>{(diagnostics?.mappings || []).slice(0, 150).map((item, index) => <tr key={`${item.sleeperPlayerId || item.externalPlayerId}-${index}`}><td>{item.name}<small>{item.sleeperPlayerId || item.externalPlayerId || '—'}</small></td><td>{item.team || '—'}</td><td>{item.position || '—'}</td><td>{item.status} · {item.confidence}</td><td>{item.method || 'No safe match'}</td></tr>)}</tbody></table></div></details></section>
  <section className="panel history"><div className="section-head"><div><p className="eyebrow">LOCAL SNAPSHOTS</p><h2>Analysis History</h2></div><span className="count-chip">{history.length} saved</span></div>{history.length ? <div className="table-wrap"><table><thead><tr><th>Analyzed</th><th>Week</th><th>Current</th><th>Recommended</th><th>Expected gain</th><th>Coverage</th><th>Moves</th></tr></thead><tbody>{history.map(item => <tr key={item.id}><td>{new Date(item.analyzedAt).toLocaleString()}</td><td>{item.season} · {item.week}</td><td><Points value={item.currentProjected} /></td><td><Points value={item.recommendedProjected} /></td><td><Points value={item.expectedImprovement} /></td><td>{item.coverage}%</td><td>{item.transactionCount}</td></tr>)}</tbody></table></div> : <p className="fine-print">No saved analyses yet.</p>}</section><section className="panel readonly"><ShieldCheck size={26} /><div><h2>Read-only by design</h2><p>This application never asks for a Sleeper password and contains no Sleeper write operations. Recommendations are advisory; roster changes must be made in Sleeper.</p></div></section></div>;
}

export function App() {
  const [loading, setLoading] = useState(true); const [config, setConfig] = useState<AppConfig | null>(null); const [analysis, setAnalysis] = useState<AnalysisResult | null>(null); const [history, setHistory] = useState<AnalysisHistoryItem[]>([]); const [tab, setTab] = useState<Tab>('overview'); const [optimizing, setOptimizing] = useState(false); const [progress, setProgress] = useState<ProgressEvent[]>([]); const [error, setError] = useState(''); const [mobileNav, setMobileNav] = useState(false); const [changing, setChanging] = useState(false);
  useEffect(() => { Promise.all([api<{ configured: boolean; config: AppConfig | null }>('/api/config'), api<{ analysis: AnalysisResult | null }>('/api/analysis/latest'), api<{ history: AnalysisHistoryItem[] }>('/api/analysis/history')]).then(([c, a, h]) => { setConfig(c.config); setAnalysis(a.analysis); setHistory(h.history); }).catch(err => setError(err.message)).finally(() => setLoading(false)); }, []);

  const optimize = async (forceRefresh = false) => {
    setOptimizing(true); setProgress([]); setError(''); setTab('overview');
    try {
      const { jobId } = await api<{ jobId: string }>('/api/optimize', { method: 'POST', body: JSON.stringify({ forceRefresh }) });
      const stream = new EventSource(`/api/jobs/${jobId}/events`);
      stream.onmessage = event => { const item = JSON.parse(event.data) as ProgressEvent; setProgress(current => [...current, item]); if (item.result) setAnalysis(item.result); if (item.done) { setOptimizing(false); stream.close(); window.setTimeout(() => api<{ history: AnalysisHistoryItem[] }>('/api/analysis/history').then(result => setHistory(result.history)).catch(() => undefined), 300); } if (item.error) setError(item.error); };
      stream.onerror = () => { setOptimizing(false); stream.close(); setError(current => current || 'The progress connection was interrupted.'); };
    } catch (err) { setOptimizing(false); setError(err instanceof Error ? err.message : 'Optimization failed.'); }
  };

  const forceRefresh = async () => {
    setError('');
    try { await api('/api/cache/external', { method: 'DELETE' }); await optimize(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not refresh external data.'); }
  };

  if (loading) return <div className="boot"><div className="brand-mark">SO</div><RefreshCw className="spin" /></div>;
  if (!config || changing) return <Setup existing={config} onCancel={config ? () => setChanging(false) : undefined} onSaved={next => { setConfig(next); setChanging(false); setAnalysis(null); }} />;
  const nav: Array<{ id: Tab; label: string; icon: typeof Gauge }> = [{ id: 'overview', label: 'Optimizer', icon: Gauge }, { id: 'team', label: 'My Team', icon: Trophy }, { id: 'matchup', label: 'Matchup', icon: Swords }, { id: 'agents', label: 'Free Agents', icon: Activity }, { id: 'league', label: 'League', icon: Users }, { id: 'settings', label: 'Settings', icon: Settings }];
  return <div className="app-shell"><aside className={mobileNav ? 'open' : ''}><div className="brand"><div className="brand-mark small">SO</div><div><strong>Sleeper</strong><span>Optimizer</span></div><button className="icon-button close-nav" onClick={() => setMobileNav(false)}><X /></button></div><nav>{nav.map(item => <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => { setTab(item.id); setMobileNav(false); }}><item.icon size={18} />{item.label}</button>)}</nav><div className="sidebar-foot"><Database size={16} /><div><strong>Local data</strong><span>Stored on this server</span></div></div></aside>{mobileNav && <button className="nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" />}
    <main className="main"><header><button className="icon-button menu" onClick={() => setMobileNav(true)}><Menu /></button><div><p className="eyebrow">{config.username}</p><h1>{config.leagueName}</h1></div><button className="button primary optimize" onClick={() => optimize()} disabled={optimizing}>{optimizing ? <><RefreshCw className="spin" size={18} /> Optimizing…</> : <><Gauge size={18} /> Optimize My Team</>}</button></header>
      <div className="content">{error && <div className="error-box"><AlertTriangle size={18} />{error}</div>}{optimizing && <div className="progress-panel"><div className="progress-title"><RefreshCw className="spin" size={18} /><div><strong>Running fresh analysis</strong><span>{progress.at(-1)?.message || 'Starting…'}</span></div></div><div className="stage-track">{progress.filter((item, index, all) => all.findIndex(other => other.stage === item.stage) === index).map(item => <span key={item.stage} className={item.done ? 'done' : ''}><Check size={13} />{item.stage.replace('_', ' ')}</span>)}</div></div>}
        {!analysis && !optimizing && <div className="empty-state"><Gauge size={36} /><h2>Ready for a fresh analysis</h2><p>Run the optimizer to refresh league data, solve your legal lineup, and inspect available players.</p><button className="button primary" onClick={() => optimize()}>Optimize My Team</button></div>}
        {analysis && tab === 'overview' && <Overview analysis={analysis} />}{analysis && tab === 'team' && <MyTeam analysis={analysis} />}{analysis && tab === 'matchup' && <Matchup analysis={analysis} />}{analysis && tab === 'agents' && <FreeAgents analysis={analysis} />}{analysis && tab === 'league' && <League analysis={analysis} />}{tab === 'settings' && <SettingsPage config={config} analysis={analysis} history={history} onChange={() => setChanging(true)} onForceRefresh={forceRefresh} refreshing={optimizing} />}
      </div></main>
  </div>;
}
