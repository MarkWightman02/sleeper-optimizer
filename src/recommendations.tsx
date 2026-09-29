import { AlertTriangle, ArrowDown, ArrowUp, CircleHelp, Pause, ShieldCheck } from 'lucide-react';
import type { AnalysisResult, LineupDecision, LineupEntry, PlayerEvaluation, TransactionRecommendation, TransactionSummary } from '../shared/types';
import { playerLookup, useAnalysis } from './context';
import { PlayerEvidence } from './evidence';
import { fmt, isOverride, KIND_LABEL, signed, signedSmart } from './format';

export const tierClass = (tier?: string) => `tier-${(tier || 'HOLD').toLowerCase().replace(' ', '-')}`;
export const ACQUISITION_LABEL = { WAIVER_CLAIM: 'Waiver claim', FREE_AGENT: 'Free-agent add', UNKNOWN: 'Waiver status unverified' } as const;

function MatchupContext({ analysis, players }: { analysis: AnalysisResult; players: Array<PlayerEvaluation | undefined> }) {
  const matchup = analysis.matchupAnalysis;
  const real = players.filter((player): player is PlayerEvaluation => Boolean(player));
  const ids = real.map(player => player.playerId);
  const faces = real.map(player => `${player.name}: ${player.team || 'FA'}${player.opponent ? ` vs ${player.opponent}` : ' (no game found)'}`);
  const correlations = matchup?.correlations.filter(note => note.players.some(ref => ids.includes(ref.playerId))) || [];
  const tiebreaks = matchup?.tiebreaks.filter(item => ids.includes(item.chosenId) || ids.includes(item.alternativeId)) || [];
  return <div className="evidence"><h4>Matchup context</h4>
    <ul>{faces.map(line => <li key={line}>{line}</li>)}</ul>
    {tiebreaks.map((item, index) => <p key={index}><strong>Decision-changing correlation.</strong> {item.explanation}</p>)}
    {correlations.map((note, index) => <p key={index}><span className={`tier ${note.effect === 'DECISION_CHANGING' ? 'tier-claim' : 'tier-hold'}`}>{note.effect === 'DECISION_CHANGING' ? 'DECISION-CHANGING' : 'INFORMATIONAL'}</span> <strong>{note.title}.</strong> {note.explanation}</p>)}
    {!tiebreaks.length && !correlations.length && <p className="fine-print">No stack or opposing-player relationship involves these players, so matchup context did not affect this decision.</p>}
  </div>;
}

export function DecisionWhy({ decision, entry }: { decision: LineupDecision; entry: LineupEntry }) {
  const analysis = useAnalysis();
  const lookup = playerLookup(analysis);
  const starter = entry.player || undefined;
  const benched = lookup.get(decision.benchId);
  const override = isOverride(decision);
  return <details className="why"><summary><CircleHelp size={14} /> Why?</summary><div className="why-body decision-why">
    <h4>Recommendation</h4><p><strong>{decision.headline}</strong></p>
    <dl className="mini-dl">
      <div><dt>{decision.startName} (start)</dt><dd>{fmt(decision.startProjection)}</dd></div>
      <div><dt>{decision.benchName} ({override ? 'benched, if healthy' : 'bench'})</dt><dd>{fmt(decision.benchProjection)}</dd></div>
      <div><dt>Difference (start − bench)</dt><dd>{signedSmart(decision.difference).replace('−', '-')} projected points</dd></div>
      {override && <div><dt>Projection sacrifice</dt><dd className="warn-text">{fmt(decision.projectionSacrifice)}</dd></div>}
      <div><dt>Availability-weighted expected</dt><dd>{fmt(decision.startExpected)} vs {fmt(decision.benchExpected)}</dd></div>
    </dl>
    {decision.whyLowerProjection && <><h4>Why recommend the lower projection?</h4><p>{decision.whyLowerProjection}</p></>}
    <h4>Decision logic</h4><ul>{decision.decisionLogic.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <h4>What could change this?</h4><ul>{decision.whatCouldChange.map((line, index) => <li key={index}>{line}</li>)}</ul>
    <MatchupContext analysis={analysis} players={[starter, benched]} />
    {starter && <><h3 className="evidence-title">Start: {starter.name}</h3><PlayerEvidence player={starter} /></>}
    {benched && <><h3 className="evidence-title">{override ? 'Benched' : 'Bench'}: {benched.name}</h3><PlayerEvidence player={benched} /></>}
  </div></details>;
}

export function PlayerWhy({ player }: { player: PlayerEvaluation }) {
  return <details className="why"><summary><CircleHelp size={14} /> Why?</summary><div className="why-body decision-why">
    <ul>{player.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    <PlayerEvidence player={player} />
  </div></details>;
}

function PlayerLine({ role, player, tone }: { role: 'START' | 'BENCH'; player: PlayerEvaluation | undefined; tone: string }) {
  if (!player) return null;
  const status = player.availability && player.availability.status !== 'ACTIVE' ? `${player.availability.status}${player.availability.injury ? ` · ${player.availability.injury}` : ''}` : null;
  return <div className={`rec-player ${tone}`}>
    <span className={`rec-badge ${role === 'START' ? 'b-start' : 'b-bench'}`}>{role === 'START' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{role}</span>
    <strong>{player.name}</strong><span className="muted">{player.positions.join('/')} · {player.team || 'FA'}{player.opponent ? ` vs ${player.opponent}` : ''}</span>
    <span className="points">{fmt(player.weeklyPoints)}</span>{status && <span className="rec-status">{status}</span>}
  </div>;
}

function LineupChangeCard({ entry }: { entry: LineupEntry }) {
  const lookup = playerLookup(useAnalysis());
  const decision = entry.decision;
  const override = isOverride(decision);
  const player = entry.player;
  if (!player) return null;
  const benched = decision ? lookup.get(decision.benchId) : entry.previousPlayerId ? lookup.get(entry.previousPlayerId) : undefined;
  const headline = decision?.headline || player.reasons[0] || 'Recommended for this slot.';
  return <article className={`rec-card ${override ? 'rec-override' : 'rec-start'}`}>
    <div className="rec-head">
      <span className="slot">{entry.slot}</span>
      <span className={`rec-kind ${override ? 'k-override' : ''}`}>{override ? 'AVAILABILITY OVERRIDE' : decision ? KIND_LABEL[decision.kind] : 'START'}</span>
      <span className="rec-meta">{decision?.difference != null && <span><small>Projection difference</small><strong className={decision.difference < 0 ? 'warn-text' : ''}>{signedSmart(decision.difference)}</strong></span>}<span><small>Data confidence</small><strong>{player.confidence}</strong></span></span>
    </div>
    <PlayerLine role="START" player={player} tone="" />
    <PlayerLine role="BENCH" player={benched} tone="dim" />
    <p className="rec-reason">{headline}</p>
    {decision ? <DecisionWhy decision={decision} entry={entry} /> : <PlayerWhy player={player} />}
  </article>;
}

export function Recommendations({ analysis }: { analysis: AnalysisResult }) {
  const changed = analysis.recommendedLineup.filter(entry => entry.changed && entry.player);
  const overrides = changed.filter(entry => isOverride(entry.decision));
  const swaps = changed.filter(entry => !isOverride(entry.decision));
  const kept = analysis.recommendedLineup.filter(entry => !entry.changed && entry.player).length;
  const summary = analysis.transactionSummary;
  const best = summary?.bestConsidered;
  return <section className="panel"><div className="section-head"><div><p className="eyebrow">RECOMMENDATIONS</p><h2>What to do for Week {analysis.week}</h2></div><span className="count-chip">{changed.length ? `${changed.length} lineup change${changed.length === 1 ? '' : 's'}` : 'No lineup changes'}</span></div>
    <div className="rec-stack">
      {overrides.length > 0 && <div className="rec-group"><h3 className="rec-group-title k-override"><AlertTriangle size={14} /> Availability overrides <span>{overrides.length}</span></h3>{overrides.map(entry => <LineupChangeCard key={`${entry.slot}-${entry.player!.playerId}`} entry={entry} />)}</div>}
      {swaps.length > 0 && <div className="rec-group"><h3 className="rec-group-title">Start / bench changes <span>{swaps.length}</span></h3>{swaps.map(entry => <LineupChangeCard key={`${entry.slot}-${entry.player!.playerId}`} entry={entry} />)}</div>}
      <div className="rec-group"><h3 className="rec-group-title">Hold</h3>
        <article className="rec-card rec-hold"><div className="rec-head"><span className="rec-kind"><Pause size={12} /> HOLD</span></div>
          <p className="rec-reason">{changed.length ? `${kept} starter${kept === 1 ? '' : 's'} stay in the lineup unchanged.` : 'The current lineup is already the best legal lineup: no changes recommended.'}</p></article>
        <article className={`rec-card ${analysis.transactions.length ? 'rec-waiver' : 'rec-hold'}`}><div className="rec-head"><span className={`rec-kind ${analysis.transactions.length ? 'k-waiver' : ''}`}>{analysis.transactions.length ? 'WAIVER' : <><Pause size={12} /> WAIVER: HOLD</>}</span></div>
          <p className="rec-reason">{analysis.transactions.length ? `${analysis.transactions.length} waiver move${analysis.transactions.length === 1 ? '' : 's'} recommended. Details below.` : summary?.headline || 'No waiver claim recommended.'}{!analysis.transactions.length && best ? ` Best alternative considered: ${best.add} for ${best.drop} (${best.tier}).` : ''}</p></article>
      </div>
    </div></section>;
}

function verdictFor(tx: TransactionRecommendation, recommended: boolean): { label: string; className: string; text: string } {
  const a = tx.assessment;
  const tier = tx.tier || 'HOLD';
  if (recommended) return { label: tier === 'STRONG CLAIM' || tier === 'CLAIM' ? 'WAIVER CLAIM' : tier, className: tierClass(tier), text: a ? `${tier}: net ${signed(a.net)} clears the +${(tier === 'STRONG CLAIM' ? a.required.strong : tier === 'CLAIM' ? a.required.claim : a.required.optional).toFixed(1)} required.` : tier };
  return { label: tier === 'AVOID' ? 'AVOID' : 'NOT RECOMMENDED', className: tierClass(tier), text: a ? `Rejected: net ${signed(a.net)} does not clear the +${a.required.optional.toFixed(1)} required for even an optional move.` : 'Rejected.' };
}

function TransactionCard({ tx, recommended }: { tx: TransactionRecommendation; recommended: boolean }) {
  const a = tx.assessment;
  const verdict = verdictFor(tx, recommended);
  return <article className={`transaction ${recommended ? 'transaction-live' : 'transaction-rejected'}`}>
    <div className="move-pair"><div><span className="move-label add">ADD</span><strong>{tx.add.name}</strong><small>{tx.add.positions.join('/')} · {tx.add.team} · {ACQUISITION_LABEL[tx.acquisition || 'UNKNOWN']}</small></div><div className="swap-line" /><div><span className="move-label drop">DROP</span><strong>{tx.drop.name}</strong><small>{tx.drop.positions.join('/')} · {tx.drop.team}</small></div></div>
    <div className="impact">
      <span><small>Raw weekly gain</small><strong>{signed(tx.weeklyGain)}</strong></span>
      <span><small>Waiver cost</small><strong>{a ? (a.waiver.cost > 0 ? `−${a.waiver.cost.toFixed(1)}` : 'None') : '—'}</strong></span>
      <span><small>Drop cost</small><strong>{a ? `−${a.drop.cost.toFixed(1)}` : '—'}</strong></span>
      <span><small>Long-term evidence</small><strong>{a ? (a.longTerm.status === 'AVAILABLE' ? `${signed(a.longTerm.rosGainPerWeek)}/wk` : 'Insufficient') : 'Unavailable'}</strong></span>
      <span><small>Net</small><strong>{a ? signed(a.net) : '—'}</strong></span>
      <span><small>Confidence</small><strong>{tx.confidence}</strong></span>
    </div>
    <div className="verdict"><span className={`verdict-badge ${verdict.className}`}>FINAL VERDICT · {verdict.label}</span><p>{verdict.text}</p></div>
    <details className="why"><summary><CircleHelp size={14} /> Why?</summary><div className="why-body wide">{a?.sections ? <dl className="why-sections">{a.sections.map(section => <div key={section.label}><dt>{section.label}</dt><dd>{section.text}</dd></div>)}</dl> : <ul>{tx.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}</div></details>
  </article>;
}

export function Transactions({ transactions, considered = [], summary }: { transactions: TransactionRecommendation[]; considered?: TransactionRecommendation[]; summary?: TransactionSummary }) {
  const rules = summary?.waiverRules;
  return <section className="panel"><div className="section-head"><div><p className="eyebrow">WAIVER REVIEW</p><h2>Waivers and Add / Drop</h2></div><span className="count-chip">{transactions.length ? `${transactions.length} move${transactions.length === 1 ? '' : 's'}` : 'HOLD'}</span></div>
    {rules && <p className="fine-print">{rules.type === 'ROLLING' ? 'Rolling waivers' : rules.type === 'FAAB' ? 'FAAB waivers' : rules.type === 'REVERSE_STANDINGS' ? 'Reverse-standings waivers' : 'Waiver type unknown'}{rules.priorityPosition != null ? ` · you are #${rules.priorityPosition} of ${rules.teams}` : ''}{rules.clearDays != null ? ` · ${rules.clearDays}-day waiver window` : ''}. A successful claim spends priority, so holding is the default.</p>}
    {!transactions.length ? <div className="no-claim"><ShieldCheck size={26} /><div><strong>NO WAIVER CLAIM RECOMMENDED</strong><p>{summary?.why || 'Your current roster is stronger than the supported available alternatives.'}</p></div></div> : <div className="transaction-list">{transactions.map(tx => <TransactionCard key={`${tx.add.playerId}-${tx.drop.playerId}`} tx={tx} recommended />)}</div>}
    {considered.length > 0 && <details className="considered"><summary>Show {considered.length} alternatives evaluated and rejected (not actionable)</summary><div className="transaction-list">{considered.map(tx => <TransactionCard key={`${tx.add.playerId}:${tx.drop.playerId}`} tx={tx} recommended={false} />)}</div></details>}
  </section>;
}

