import { AlertTriangle, Link2, Swords } from 'lucide-react';
import type { AnalysisResult, CorrelationKind, CorrelationNote, MatchupAnalysis, MatchupTeamLine } from '../shared/types';
import { CLOSE_MARGIN, fmt, signed } from './format';

const KIND_LABEL: Record<CorrelationKind, string> = {
  CATCHER_VS_OPPONENT_QB: 'Your pass catcher vs. their QB', QB_VS_OPPONENT_CATCHER: 'Your QB vs. their pass catcher',
  MY_STACK: 'Your QB + pass-catcher stack', OPPONENT_STACK: 'Their QB + pass-catcher stack',
  MY_DEFENSE_VS_OPPONENT_OFFENSE: 'Your defense vs. their offense', OPPONENT_DEFENSE_VS_MY_OFFENSE: 'Their defense vs. your offense',
  MY_SHARED_QB: 'Your pass catchers share a QB', OPPONENT_SHARED_QB: 'Their pass catchers share a QB'
};

function Cell({ line, linked }: { line: MatchupTeamLine | undefined; linked: boolean }) {
  if (!line || !line.playerId) return <span className="muted">{line ? 'No eligible player' : '—'}</span>;
  return <div className="mu-player"><strong>{line.name}{linked && <Link2 size={12} className="mu-link" aria-label="Part of a correlation" />}</strong>
    <small>{line.positions.join('/')} · {line.team || 'FA'}{line.opponent ? ` vs ${line.opponent}` : ' · no game'}</small>
    {line.statusDetail && <small className="warn-text">{line.statusDetail}</small>}</div>;
}

const points = (line: MatchupTeamLine | undefined) => line?.weeklyPoints == null ? <span className="muted">—</span> : <strong className="points">{line.weeklyPoints.toFixed(1)}</strong>;

function LineupCompare({ matchup }: { matchup: MatchupAnalysis }) {
  const linkedIds = new Set(matchup.correlations.flatMap(note => note.players.map(player => player.playerId)));
  const rows = Math.max(matchup.myLineup.length, matchup.opponentLineup.length);
  return <div className="table-wrap"><table className="mu-table"><thead><tr><th>You</th><th>Proj.</th><th>Slot</th><th>Δ</th><th>Proj.</th><th>Opponent</th></tr></thead><tbody>
    {Array.from({ length: rows }, (_, index) => {
      const mine = matchup.myLineup[index]; const theirs = matchup.opponentLineup[index];
      const value = (line?: MatchupTeamLine) => line?.expectedPoints ?? line?.weeklyPoints ?? null;
      const a = value(mine); const b = value(theirs);
      const diff = a != null && b != null ? a - b : null;
      const close = diff != null && Math.abs(diff) < CLOSE_MARGIN;
      return <tr key={index} className={`${mine?.statusDetail || theirs?.statusDetail ? 'mu-injury' : ''}`}>
        <td className={diff != null && diff >= CLOSE_MARGIN ? 'mu-lead' : ''}><Cell line={mine} linked={Boolean(mine?.playerId && linkedIds.has(mine.playerId))} /></td>
        <td className={diff != null && diff >= CLOSE_MARGIN ? 'mu-lead' : ''}>{points(mine)}</td>
        <td><span className="slot">{mine?.slot || theirs?.slot}</span></td>
        <td className={close ? 'mu-close' : diff != null && diff < 0 ? 'danger-text' : 'good'}>{diff == null ? '—' : <>{signed(diff)}{close && <small>close</small>}</>}</td>
        <td className={diff != null && diff <= -CLOSE_MARGIN ? 'mu-lead' : ''}>{points(theirs)}</td>
        <td className={diff != null && diff <= -CLOSE_MARGIN ? 'mu-lead' : ''}><Cell line={theirs} linked={Boolean(theirs?.playerId && linkedIds.has(theirs.playerId))} /></td>
      </tr>;
    })}
    <tr className="mu-total"><td>Projected total</td><td><strong className="points">{matchup.myProjected?.toFixed(1) ?? '—'}</strong></td><td /><td className={(matchup.difference ?? 0) < 0 ? 'danger-text' : 'good'}>{signed(matchup.difference)}</td><td><strong className="points">{matchup.opponentProjected?.toFixed(1) ?? '—'}</strong></td><td>{matchup.opponentName}</td></tr>
  </tbody></table></div>;
}

function Correlation({ note }: { note: CorrelationNote }) {
  const changing = note.effect === 'DECISION_CHANGING';
  return <article className={`corr-card ${changing ? 'corr-changing' : ''}`}>
    <div className="corr-head"><span className={`corr-badge ${changing ? 'c-changing' : 'c-info'}`}>{changing ? 'DECISION-CHANGING' : 'INFORMATIONAL ONLY'}</span><strong>{note.title}</strong><small>{KIND_LABEL[note.kind]}</small></div>
    <div className="corr-players">{note.players.map(player => <span key={`${player.side}-${player.playerId}`} className={player.side === 'mine' ? 'side-mine' : 'side-opp'}>{player.side === 'mine' ? 'YOU' : 'OPP'} · {player.name} <small>{player.position} · {player.team} · {fmt(player.projection)}</small></span>)}</div>
    <p>{note.explanation}</p>
    <small>Scoring overlap: {note.overlap}</small>
    <small className={changing ? 'good' : ''}>{note.effectNote}</small>
  </article>;
}

export function Matchup({ analysis }: { analysis: AnalysisResult }) {
  const matchup = analysis.matchupAnalysis;
  if (!matchup) return <div className="page-stack"><div className="empty-good"><Swords size={22} /><div><strong>No Week {analysis.week} opponent is available.</strong><p>{analysis.weekSelection?.matchupNote || "This can happen on a bye week, in the playoffs, or before the league's schedule is set."}</p></div></div></div>;
  const incomplete = [...matchup.incompleteStarters.mine, ...matchup.incompleteStarters.opponent];
  const close = matchup.positionEdges.filter(edge => edge.difference != null && Math.abs(edge.difference) < CLOSE_MARGIN);
  const u = matchup.uncertainty;
  return <div className="page-stack">
    <section className="panel"><div className="section-head"><div><p className="eyebrow">WEEK {analysis.week} MATCHUP{matchup.matchupId != null ? ` · #${matchup.matchupId}` : ''}</p><h2>You vs. {matchup.opponentName}</h2></div></div>
      <div className="mu-scoreboard"><div><small>You</small><strong>{matchup.myProjected?.toFixed(1) ?? '—'}</strong></div><div className={(matchup.difference ?? 0) < 0 ? 'neg' : 'pos'}><small>Projected difference</small><strong>{signed(matchup.difference)}</strong></div><div><small>{matchup.opponentName}</small><strong>{matchup.opponentProjected?.toFixed(1) ?? '—'}</strong></div></div>
      <p className="fine-print">{matchup.totalBasis}{matchup.myPublished != null && matchup.opponentPublished != null && (matchup.myPublished !== matchup.myProjected || matchup.opponentPublished !== matchup.opponentProjected) ? ` Ignoring availability, the published totals are ${matchup.myPublished.toFixed(1)} vs ${matchup.opponentPublished.toFixed(1)}.` : ''}</p>
      {incomplete.length > 0 && <div className="warning compact"><AlertTriangle size={17} /><span>Totals are unavailable because these starters have no projection: {incomplete.join(', ')}. A missing projection is never counted as 0.</span></div>}
      <LineupCompare matchup={matchup} />
    </section>
    <div className="mu-grid">
      <section className="panel"><p className="eyebrow">WHERE THE MARGIN COMES FROM</p><h2>Positional edges</h2>
        <div className="edge-list">{matchup.positionEdges.map(edge => { const d = edge.difference; const width = d == null ? 0 : Math.min(100, Math.abs(d) * 10); return <div key={edge.group} className="edge-row"><strong>{edge.group}</strong><div className="edge-bar"><span className={d != null && d < 0 ? 'neg' : 'pos'} style={{ width: `${width}%`, [d != null && d < 0 ? 'right' : 'left']: '50%' } as React.CSSProperties} /></div><span className={d == null ? 'muted' : Math.abs(d) < CLOSE_MARGIN ? 'mu-close' : d < 0 ? 'danger-text' : 'good'}>{signed(d)}{d != null && Math.abs(d) < CLOSE_MARGIN ? ' close' : ''}</span></div>; })}</div>
        <p className="fine-print">Largest advantages: {matchup.largestAdvantages.length ? matchup.largestAdvantages.map(edge => `${edge.group} ${signed(edge.difference)}`).join(', ') : 'none'}. Largest disadvantages: {matchup.largestDisadvantages.length ? matchup.largestDisadvantages.map(edge => `${edge.group} ${signed(edge.difference)}`).join(', ') : 'none'}.{close.length ? ` Close comparisons: ${close.map(edge => edge.group).join(', ')}.` : ''}</p></section>
      <section className="panel"><p className="eyebrow">INJURIES AND UNCERTAINTY</p><h2>Who could swing this</h2>
        {matchup.uncertainStarters.length ? <div className="considered-list">{matchup.uncertainStarters.map(item => <div key={`${item.side}-${item.playerId}`}><span className={`tier ${item.side === 'mine' ? 'tier-upgrade' : 'tier-marginal'}`}>{item.side === 'mine' ? 'YOU' : 'OPP'}</span><strong>{item.name} ({item.slot})</strong><span>{item.detail}</span><span>{fmt(item.weeklyPoints)}</span></div>)}</div> : <p className="fine-print">No injury-uncertain starters on either side.</p>}
        <p className="fine-print"><strong>{u.moreUncertain === 'mine' ? 'Your lineup is more uncertain.' : u.moreUncertain === 'opponent' ? "Your opponent's lineup is more uncertain." : u.moreUncertain === 'even' ? 'About even uncertainty.' : 'Uncertainty is mixed.'}</strong> {u.explanation}</p>
        <p className="fine-print">{matchup.winProbabilityNote}</p></section>
    </div>
    <section className="panel"><div className="section-head"><div><p className="eyebrow">STACKS AND INTERACTIONS</p><h2>Correlation analysis</h2></div><span className="count-chip">{matchup.correlations.length} shown</span></div>
      <p className="fine-print">Expected points stay the primary objective. Correlation changes the spread of possible outcomes, not the expected total, and only ever breaks near-ties.</p>
      {matchup.correlations.length ? <div className="corr-list">{matchup.correlations.map((note, index) => <Correlation key={index} note={note} />)}</div> : <p className="fine-print">No relevant relationships between starters were found this week.</p>}
      {matchup.tiebreaks.length > 0 && <><h3>Decisions decided by correlation</h3>{matchup.tiebreaks.map((item, index) => <p key={index} className="fine-print">{item.explanation}</p>)}</>}
    </section>
    {matchup.waiverContext.length > 0 && <section className="panel"><p className="eyebrow">SUPPORTING CONTEXT ONLY</p><h2>Waiver options vs. this opponent</h2>{matchup.waiverContext.map((item, index) => <p key={index} className="fine-print"><strong>{item.add} for {item.drop}:</strong> {item.note}</p>)}</section>}
  </div>;
}
