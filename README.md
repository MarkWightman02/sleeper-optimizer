# Sleeper Optimizer

Sleeper Optimizer is a self-hosted, read-only fantasy-football dashboard. It refreshes a selected Sleeper league from scratch on every run, gathers current published projections/rankings/injuries/news from multiple free public sources, builds a transparent consensus, scores it with that league's exact scoring settings, solves the best legal lineup, evaluates realistic waiver transactions, and compares your recommended lineup against your current weekly opponent.

It never asks for a Sleeper password or calls a Sleeper write endpoint. Every recommendation is advisory. **No paid API key or account is required for anything in this application.**

## What it does

- Discovers leagues from a Sleeper username and persists the selected league locally.
- Refreshes NFL state, league rules, rosters, users, matchups, and your current weekly opponent on every run — never reuses a stale prior analysis.
- Fetches free weekly stat projections and expert-panel ranks from ESPN's public fantasy API, official weekly injury reports and depth charts/snap counts/schedule from nflverse, and recent player news from ESPN and RotoBaller.
- Recalculates fantasy points from projected statistics with the selected league's Sleeper scoring map — never copies a generic external point total.
- Maps players via a community-maintained ID crosswalk (which already joins Sleeper IDs directly) with a conservative name/team/position fallback. Ambiguous matches are rejected, not guessed.
- Solves repeated FLEX, SUPER_FLEX, DEF/K, and IDP lineups exactly.
- Calculates league-specific replacement levels, value over replacement (VOR), scarcity, and confidence.
- Re-optimizes the entire lineup after every bounded one- and two-player add/drop candidate.
- Compares your recommended lineup's projected total against your actual current opponent's, and surfaces QB/pass-catcher (and defense/offense) correlations as a bounded tiebreaker on genuinely close lineup decisions — never enough to override a real projection gap.
- Shows auditable scoring components, source-by-source projections/rankings/news, mapping diagnostics, recommendation tiers, and saved analysis history.
- Streams real backend progress (one stage per actual awaited step) to the browser with server-sent events.

## Run with Docker

Clone the repository onto any Docker host:

```bash
git clone https://github.com/MarkWightman02/sleeper-optimizer.git
cd sleeper-optimizer
```

Docker Engine with Docker Compose is the only host requirement. No `.env` values are required — copy it only if you want to override the default port/host.

```bash
cp .env.example .env   # optional, no keys needed
docker compose up -d --build
```

Then open **`http://<DOCKER_HOST_IP>:8009`** from any device on your LAN — not merely `http://localhost:8009`. The server binds to `0.0.0.0` inside the container, and Compose maps `8009:8009`.

```bash
docker compose ps
docker compose logs -f sleeper-optimizer
curl http://127.0.0.1:8009/api/health
```

`docker compose down` preserves the named `sleeper-optimizer-data` volume. `docker compose down -v` permanently deletes local configuration, caches, mappings, and analysis history.

## Free data sources

| Source | Access | Contributes |
| --- | --- | --- |
| [Sleeper public API](https://docs.sleeper.com/) | No auth | Authoritative league/roster/scoring/ownership/matchup/state data |
| [DynastyProcess player ID crosswalk](https://github.com/dynastyprocess/data) | Public GitHub CSV | Sleeper ↔ ESPN/GSIS ID join for player identity |
| [nflverse-data](https://github.com/nflverse/nflverse-data) | Public GitHub release CSVs | Schedules/gametime/Vegas lines, official weekly injury reports, depth charts, snap counts, recent actual stats |
| ESPN Fantasy player API (`lm-api-reads.fantasy.espn.com`) | No auth, no league required | Per-player weekly **stat** projections (rescored with this league's settings) and ESPN's own expert-panel ranks |
| ESPN NFL News API (`site.web.api.espn.com`) | No auth | Recent player news, matched to players by ESPN's own athlete-ID tags |
| [RotoBaller RSS feed](https://www.rotoballer.com/feed) | Public RSS | A second, independent news source |

Every source is fetched with a short, identifying User-Agent, a bounded timeout, and a cache TTL appropriate to how often it actually changes (volatile data such as injuries, news and projections is re-fetched on every run; only the ID crosswalk is cached for 24h). No paid provider is used anywhere in this application.

### Source resilience

Each source above is its own independent provider. If one fails (timeout, HTTP error, unexpected shape), the run continues with the rest — nothing is fabricated to fill the gap. Settings → diagnostics shows `Sources succeeded: M / N` and a per-source status (`SUCCESS`/`FAILED`/`TIMEOUT`/`PARSE_ERROR`/`BLOCKED`) with the actual error text.

## Consensus, confidence, and correlation

- **Projection** = a numeric forecast actually published by a source (currently ESPN's weekly stat line, rescored with this league's settings). **Consensus projection** = the transparent average of every published numeric projection for that player; every individual source value is retained and shown in the UI, never blurred with the average.
- **Ranking** = a published ordinal rank (ESPN's expert-panel ranks). Rankings are never converted into fabricated point values — they're supporting evidence for confidence and tiebreaking only.
- **Confidence** (`server/engine/consensus.ts`) is a documented, deterministic score built from: number of projection sources, numeric agreement between them, ranking support, player-identity mapping certainty, scoring coverage, and injury/availability uncertainty. It is never itself a projection.
- **Correlation** (`server/engine/correlation.ts`): when one of your players shares an NFL team with your current opponent's starter in a QB/pass-catcher relationship, a small bonus — capped well below the league's own decision band — is added to that player's lineup score. It can tip a genuinely close call between two of your own players, but it is mathematically incapable of overriding a real projection gap larger than the band.

## Injuries and availability

Published projections are never altered for injuries. Availability is tracked separately (status, injury, practice, latest news with source and timestamp, confidence, risk flag) and applied through a documented rule: OUT/IR is excluded, DOUBTFUL takes a strong penalty, QUESTIONABLE is only a modest haircut unless practice or news says otherwise, and ACTIVE is optimized purely on projection. The Optimizer page shows the best lineup if everyone plays, the recommended lineup after availability, and the exact projection sacrifice. Every recommendation with a lower-projected starter is labelled AVAILABILITY OVERRIDE with the reason, evidence, timestamps and what would change it. Full policy: [ARCHITECTURE.md](./ARCHITECTURE.md#availability-policy-injuries-vs-projections).

Every Optimize re-fetches injury, news, projection and Sleeper-catalog data; a cached copy is used only if the live fetch fails and is then labelled STALE.

## Scoring and optimization

ESPN's projected stat line is rescored from documented stat IDs (passing/rushing/receiving yards and touchdowns, receptions, kicking, defense, and IDP stats) using this league's actual `scoring_settings`, including decimal, negative, and bonus values. An unsupported or granularity-mismatched Sleeper key (e.g. this league's 0–19/20–29/30–39 yard field-goal buckets, which ESPN only reports as a combined 0–39 bucket) contributes nothing and is listed in diagnostics — never guessed.

The lineup solver uses bitmask dynamic programming for an exact maximum-weight assignment under the league's actual roster slots. Missing projections remain `null`; they are not converted into meaningful zeroes. Replacement level, VOR, and scarcity are unchanged. Add/drop recommendations default to HOLD and must clear a documented waiver-priority, drop-cost and long-term-evidence threshold (tiers STRONG CLAIM / CLAIM / OPTIONAL / SPECULATIVE / HOLD / AVOID, with a per-move Why? breakdown) — see "Waiver and add/drop decisions" in [ARCHITECTURE.md](./ARCHITECTURE.md).

## Persistence and API

SQLite in `/data` stores app configuration, the Sleeper catalog, provider response caches (including the ID crosswalk and every nflverse/ESPN/news dataset), and the latest 20 completed analyses. Relevant endpoints:

- `GET /api/analysis/latest`
- `GET /api/analysis/history`
- `GET /api/diagnostics`
- `POST /api/optimize` with optional `{ "forceRefresh": true }`
- `DELETE /api/cache/external` — clears all cached external source data

## Versioning

Semantic versioning; the canonical version lives in `package.json` (currently `0.1.0`) and is shown at the bottom of the Settings/Diagnostics tab. See [CHANGELOG.md](CHANGELOG.md).

## Development and tests

Local development requires Node.js 22 and a native toolchain for `better-sqlite3`.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

Tests are entirely fixture-based — **no live network access is required or used** to run `npm test`. They cover custom scoring against ESPN's documented stat IDs, projection consensus and confidence tiers, identity mapping (exact/fallback/ambiguous), injury normalization, FLEX/SUPER_FLEX legality, replacement level, transaction thresholds, and the correlation tiebreaker (including that it cannot override a large projection gap).

## Limitations

- Only ESPN currently publishes a free, ToS-respecting numeric weekly stat projection; most players will show one projection source plus supporting rankings/news rather than a multi-source numeric average. The consensus math supports N sources, so adding another numeric provider later is additive.
- ESPN's standard fantasy product does not carry individual defensive-player (IDP) projections; IDP leagues get real Sleeper/nflverse identity, injury, and usage data but no ESPN projection for those players specifically.
- The player mapper deliberately leaves ambiguous identities unmatched. Diagnostics expose those rows for review.
- Search is bounded (10 primary adds, 14 drops, best six of each for two-swaps) — not an exhaustive traversal of every possible roster.
- This is intended for a trusted LAN. Put it behind an authenticated reverse proxy and HTTPS before exposing it publicly.
- The app never submits lineups, claims, trades, or roster changes.

## Troubleshooting

**A source shows FAILED/TIMEOUT/BLOCKED:** open Settings → source status for the exact error. Optimize still runs on the remaining sources; nothing is fabricated to compensate.

**No leagues are found:** verify the exact Sleeper username and that it has a current-season NFL league.

**Another LAN device cannot connect:** confirm `docker compose ps` shows `0.0.0.0:8009->8009/tcp`, use the Docker host's LAN IP, and permit TCP 8009 through its firewall.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the detailed data flow and failure model.

## Target week (automatic)

Optimize picks one `targetWeek` and passes it to every provider (ESPN projections/rankings, nflverse schedule, injuries and usage, matchup and opponent lookup, free-agent evaluation, lineup solve, news, correlation, history, diagnostics, UI). It starts from Sleeper's week and advances to the next week only when every relevant game (active-roster players at fantasy positions) has already kicked off, judged by the scheduled kickoff instants in nflverse `games.csv` (Eastern wall clock converted to UTC; reschedules follow the new time; no published time counts as unplayed until end of gameday). Bye-week or teamless players do not keep the current week active. It never advances outside the regular season or if the schedule has no games for the next week. The next-week matchup is fetched from Sleeper for that week; if unpublished, the roster is still optimized and opponent analysis is shown as unavailable. See `server/engine/target-week.ts`.
