import type { AvailabilityEvidence, PlayerEvaluation, ProjectionValue } from '../shared/types';
import { fmt, fmtTime } from './format';

function ProjectionSource({ projection, displayed }: { projection: ProjectionValue; displayed: number | null }) {
  const provenance = projection.provenance;
  const components = (projection.scoringComponents || []).filter(component => component.projectedPoints != null);
  const sum = components.reduce((total, component) => total + (component.projectedPoints || 0), 0);
  const reconciles = Math.abs(sum - projection.points) <= 0.05;
  return <div className="evidence-source">
    <div className="evidence-line"><strong>{projection.source}</strong><span>{projection.points.toFixed(2)} pts</span></div>
    <small>Retrieved {fmtTime(projection.retrievedAt)}{projection.stale ? ' — STALE cached copy (live fetch failed)' : ''}</small>
    {provenance && <small>Provider player {provenance.providerPlayerId}{provenance.providerPlayerName ? ` (${provenance.providerPlayerName})` : ''} · {provenance.season} week {provenance.week} · statSourceId {provenance.statSourceId} (projection) · split {provenance.statSplitTypeId} (single week)</small>}
    {components.length > 0 && <div className="component-list compact">
      {components.map((component, index) => <div key={`${component.providerStat}-${index}`} className={component.modeled ? '' : 'unmodeled'}><span>{component.sleeperKey || component.providerStat}</span><span>{component.projectedStat ?? '—'}</span><span>{component.multiplier != null ? `× ${component.multiplier}` : component.note || 'not scored'}</span><strong>{component.projectedPoints! >= 0 ? '+' : ''}{component.projectedPoints!.toFixed(2)}</strong></div>)}
      <div className="consensus-row"><span>Raw stat × league scoring = converted projection</span><strong className={reconciles ? '' : 'warn-text'}>{sum.toFixed(2)}{reconciles ? '' : ` ≠ ${projection.points.toFixed(2)}`}</strong></div>
    </div>}
    {provenance && Object.keys(provenance.rawStatLine).length > 0 && <details className="raw-line"><summary>Raw provider stat line</summary><div className="sources">{Object.entries(provenance.rawStatLine).map(([id, value]) => <span key={id}>{id}: {value}</span>)}</div></details>}
    {provenance?.approximations.length ? <small className="warn-text">Approximations: {provenance.approximations.join('; ')}</small> : null}
    {provenance?.omittedKeys.length ? <small>Scoring rules the source did not project (count as 0, listed for transparency): {provenance.omittedKeys.join(', ')}</small> : null}
    <small>Displayed projection: {fmt(displayed)}{projection.points === displayed ? ' (matches this source)' : ''}</small>
  </div>;
}

function EvidenceRow({ item }: { item: AvailabilityEvidence }) {
  return <div className={`evidence-row ${item.used ? 'used' : 'ignored'}`}>
    <span className="tier">{item.used ? 'USED' : 'IGNORED'}</span>
    <div><strong>{item.detail}</strong><small>{item.source} · {item.kind} · published {fmtTime(item.publishedAt)} · retrieved {fmtTime(item.retrievedAt)} · {item.targetWeek != null ? `week ${item.targetWeek}` : 'week not stated'}</small>{item.note && <small>{item.note}</small>}</div>
  </div>;
}

/** Answers "why is this player projected at X, ranked Y, and available at Z?" with source, raw data, converted result and timestamps. */
export function PlayerEvidence({ player }: { player: PlayerEvaluation }) {
  const availability = player.availability;
  return <div className="evidence">
    <h4>Projection{player.projections.length > 1 ? ` — consensus of ${player.projections.length} sources ${fmt(player.weeklyPoints)}` : ''}</h4>
    {player.projections.length ? player.projections.map((projection, index) => <ProjectionSource key={`${projection.source}-${index}`} projection={projection} displayed={player.weeklyPoints} />) : <p className="fine-print">No projection source covered this player. No points were fabricated, and a missing projection is never treated as 0.</p>}
    <h4>Ranking <small>ordinal only, never converted to points</small></h4>
    {player.rankings.length ? <div className="component-list compact">{player.rankings.map((ranking, index) => <div key={index}><span>{ranking.source}{ranking.week != null ? ` · wk ${ranking.week}` : ''}</span><span>{ranking.scoringType || ''}</span><span>{ranking.expertCount ? `${ranking.expertCount} experts${ranking.rankMin != null ? ` (#${ranking.rankMin}–#${ranking.rankMax})` : ''}` : ''}</span><strong>{ranking.positionRank != null ? `#${ranking.positionRank}` : '—'}</strong></div>)}<small className="pad">Retrieved {fmtTime(player.rankings[0].retrievedAt)}{player.rankings.some(ranking => ranking.stale) ? ' — STALE cached copy' : ''}</small></div> : <p className="fine-print">No published ranking is available for this player.</p>}
    <h4>Availability</h4>
    {availability ? <>
      <dl className="mini-dl"><div><dt>Status</dt><dd>{availability.status}{availability.rawStatus && availability.rawStatus !== availability.status ? ` (${availability.rawStatus})` : ''} · risk {availability.riskFlag}</dd></div><div><dt>Injury / practice</dt><dd>{availability.injury || 'not reported'}{availability.practice ? ` · ${availability.practice}` : ''}</dd></div><div><dt>Play estimate</dt><dd>{Math.round(availability.playProbability * 100)}% → expected {fmt(player.expectedPoints)}<small>{availability.policy}</small></dd></div><div><dt>Deciding source</dt><dd>{availability.statusSource}{availability.sourceStale ? ' — STALE fallback' : ''}<small>updated {fmtTime(availability.statusUpdatedAt)} · retrieved {fmtTime(availability.retrievedAt)} · target week {availability.targetWeek ?? '—'}</small></dd></div><div><dt>Availability confidence</dt><dd>{availability.confidence}<small>{availability.confidenceReasons.join('; ')}</small></dd></div></dl>
      {availability.evidence?.length ? <div className="evidence-list">{availability.evidence.map((item, index) => <EvidenceRow key={index} item={item} />)}</div> : null}
    </> : <p className="fine-print">No availability assessment.</p>}
    <h4>News</h4>
    {player.newsItems.length ? <div className="news-list">{player.newsItems.map((item, index) => <div key={index}><strong>{item.headline}</strong>{item.summary && <p>{item.summary}</p>}<small>{item.source}{item.publishedAt ? ` · published ${fmtTime(item.publishedAt)}` : ' · no timestamp'}</small></div>)}</div> : <p className="fine-print">No recent news was found for this player.</p>}
    <h4>Data confidence — {player.confidence}</h4>
    {player.confidenceReasons?.length ? <ul>{player.confidenceReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}
    <small>Confidence reflects data quality (sources, freshness, agreement, mapping, injury uncertainty), never player quality. Mapping: {player.mappingConfidence || 'unmapped'}{player.mappingMethod ? ` · ${player.mappingMethod}` : ''}.</small>
  </div>;
}
