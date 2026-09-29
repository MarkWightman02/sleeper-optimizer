# Sleeper Optimizer architecture

## Runtime and boundaries

The application is one TypeScript project: React/Vite in the browser, Express serving both API and compiled assets, and SQLite through `better-sqlite3`. One Docker container binds to `0.0.0.0:8009`; one `/data` volume retains all local state. Server-sent events report real optimization stages — each stage corresponds to an actual awaited step, not a timer.

Sleeper Optimizer is read-only. It collects no Sleeper credential and contains no Sleeper write path. It requires no API key for any provider.

## Data flow

1. `SleeperApi` (`server/services/sleeper.ts`) loads documented public state, league, user, roster, matchup, and player endpoints. Ownership/free-agency is computed only from Sleeper IDs, freshly, every run.
2. `loadCrosswalk` (`server/services/crosswalk.ts`) fetches the community-maintained DynastyProcess `db_playerids.csv` (cached ~24h) — it already joins Sleeper IDs to ESPN/GSIS/other provider IDs directly.
3. `resolvePlayerIdentities` (`server/services/player-mapping.ts`) resolves every relevant Sleeper player to an ESPN ID: the crosswalk's own `sleeper_id` join first, then a persisted mapping from a prior run, then a `gsis_id`/`espn_id` cross-match, then normalized name+team+position, then name+position. Ambiguous and unmatched rows are diagnostics, never guesses.
4. `loadEspnProjections` (`server/providers/espn.ts`) fetches ESPN's public per-player weekly stat line (`lm-api-reads.fantasy.espn.com`) and its own expert-panel ranks, for every mapped player, in one bulk request.
5. `loadNflverseBundle` (`server/providers/nflverse.ts`) fetches five independent nflverse CSV releases (schedules, depth charts, official weekly injury reports, snap counts, recent actual weekly stats) — each with its own cache TTL and its own failure handling.
6. `loadEspnNews` / `loadRotoBallerNews` (`server/providers/news.ts`) fetch recent news; ESPN's news is matched to players via its own athlete-ID tags (exact), RotoBaller's RSS via normalized name matching (only for players actually being evaluated).
7. `scoreEspnProjection` (`server/engine/scoring.ts`) maps ESPN's documented numeric stat IDs to Sleeper scoring keys and retains an auditable component list plus an unsupported-key list (including granularity mismatches, e.g. field-goal distance buckets).
8. `combineInjuryStatus` (`server/engine/injuries.ts`) normalizes nflverse's official weekly report and Sleeper's own status fields to one severity-ranked model, keeping the more severe of the two.
9. `combineProjections` / `computeConfidence` (`server/engine/consensus.ts`) build the transparent numeric consensus and the documented confidence tier.
10. The exact lineup solver (`server/engine/optimizer.ts`) and bounded transaction search generate the base recommendation; `correlationBonusMap`/`buildCorrelationNotes` (`server/engine/correlation.ts`) add a bounded, band-capped nudge for QB/pass-catcher stacks shared with the current opponent, then produce human-readable correlation notes for the Matchup view.
11. `runAnalysis` (`server/engine/analysis.ts`) orchestrates all of the above, also resolving the current-week opponent from `matchup_id`, evaluating their lineup with the same pipeline, and computing the projected difference.
12. SQLite stores the result snapshot; Express exposes latest/history/diagnostic routes; React renders the audit trail, including a dedicated Matchup tab.

## Persistence

- `app_config`: selected user and league.
- `cache`: large Sleeper player catalog (re-fetched every run; the cached copy is only a flagged stale fallback).
- `provider_cache`: generic `(source, cache_key) → value` store used by the crosswalk, every nflverse dataset, ESPN, and news — each with its own TTL and its own stale-fallback-on-failure behavior.
- `player_mappings`: persisted Sleeper → ESPN ID fallback matches (only for players the crosswalk doesn't directly resolve), so repeat runs don't re-fuzzy-match players who've already been confirmed.
- `analyses`: latest 20 immutable result snapshots, including `analysisStartedAt` and `dataThroughAt` (the max `retrievedAt` across every source that run).

## Scoring coverage

Only documented, semantically safe stat-ID mappings are scored (see `ESPN_STAT_MAP` in `server/engine/scoring.ts`). Each component retains the raw ESPN stat ID, the Sleeper key, the multiplier, the projected stat, the resulting points, and whether it was modeled. A configured Sleeper key with no safe ESPN mapping — or one where ESPN's own bucket boundaries don't line up with the league's (e.g. FG 0–39 vs. this league's 0–19/20–29/30–39) — is reported as unsupported rather than approximated.

Coverage is the percentage of relevant configured scoring keys represented for a projection. It contributes to confidence but never causes a fabricated value.

## Consensus and confidence

`combineProjections` averages every published numeric projection for a player (currently just ESPN in practice — the function is generic over N sources). `computeConfidence` is a fixed, documented point score: +2/+1 for 2+/1 projection source(s), ±agreement bonus/penalty based on relative spread between sources, +1 for 2+ ranking sources, ±1 to −3 for mapping confidence, ±1 for scoring coverage, −1 to −2 for injury/availability uncertainty. `Unavailable` only when there is no projection and no ranking at all.

## Opponent and correlation

Each run resolves the current-week opponent from the Sleeper matchup's `matchup_id` (the other roster sharing it), evaluates their actual current starters through the identical pipeline, and reports both projected totals side by side. `decisionBand` (`server/engine/optimizer.ts`, derived from the league's own free-agent drop-off curve — the same figure used for waiver decisions) bounds a small correlation nudge: a player who shares an NFL team with one of the opponent's starters in a QB/pass-catcher relationship gets a bonus capped at `min(band × 0.4, 0.5)`, which is small enough that it can only ever flip a choice that was already within the band — never override a real gap. `buildCorrelationNotes` then produces the human-readable explanation shown on the Matchup tab, marking which (if any) were actually used as a tiebreak.

## Availability policy (injuries vs. projections)

Source of truth: the header comment in `server/engine/availability.ts`. Keep this section in sync with it.

**Projection and availability are separate fields.** A player's published `weeklyPoints` is never edited for an injury. `PlayerEvaluation` carries the projection, an `availability` assessment (status, injury, practice, latest news with its source and timestamp, confidence, risk flag, play estimate) and a derived `expectedPoints = weeklyPoints × playProbability`. The exact lineup solver maximizes `expectedPoints`, so the objective is always expected points. Secondary terms (a 0.0001 continuity nudge and the bounded correlation bonus, capped below the decision band) can only break near-ties.

| Designation | Play estimate | Effect |
|---|---|---|
| ACTIVE / no concern | 1.00 | Normal projection-first optimization |
| UNKNOWN | 0.90 | Small haircut |
| QUESTIONABLE | 0.85 baseline | **Never auto-benched.** Full practice 0.95, limited 0.80, did-not-practice 0.50; explicit negative news caps at 0.50; positive news raises to at least 0.95. A bare "Questionable" label costs 15%, so it cannot displace a 5+ point edge |
| DOUBTFUL | 0.25 (0.40 with positive news) | Strong penalty; still used if nothing comparable exists |
| OUT / IR / PUP / SUSPENDED | 0 | Excluded from the lineup (`eligible = false`) |

News is classified by fixed keyword rules (`classifyNews`) as negative, positive or neutral. Confidence is High for an official report or Sleeper corroborated by news, Medium for a single unofficial source, and Low when the source was only available from a stale cache, sources conflict, or news suggests a problem that no designation confirms.

**Decisions** (`server/engine/decisions.ts`) classify every changed slot as `PROJECTION`, `CLOSE_CALL` (gain inside the decision band), `TOSS_UP` (within 0.1 point), `AVAILABILITY_EXCLUSION`, `AVAILABILITY_DISCOUNT` or `NO_PROJECTION`. Availability kinds are the only ones where the started player has the lower published projection; they show the exact projection sacrifice, the status/source/timestamp/confidence, the expected-points math, why the sacrifice is accepted, the break-even play probability and what would change the recommendation. Displaced/new starters are paired by set difference, not slot order.

**Pure vs. recommended.** `optimizeIfEveryonePlays` re-admits every player at his published projection to produce the "best lineup if everyone plays"; the difference to the recommended lineup's projection total is reported as the availability projection sacrifice.

**Freshness.** Optimize starts from scratch. Sleeper's player catalog (which carries injury status), ESPN, all nflverse datasets and news use `VOLATILE_MAX_AGE_MS = 0` (`server/providers/freshness.ts`) and are re-fetched on every run. Cached copies are used only when the live fetch fails, and are then flagged `stale` (Low availability confidence, warning banner, "STALE CACHE" in diagnostics). Only the ID crosswalk (static reference data) keeps a 24h TTL.

**Timing caveat.** Kickoffs come from nflverse as Eastern wall-clock times and are converted to UTC. If a starter's game has already kicked off for the analysis week, the app warns that a designation issued after the game mainly concerns the next game.

## Lineup and waiver model

Lineup solving is unchanged from the original design (add/drop decisions are covered in "Waiver and add/drop decisions" below): starter slots come directly from `league.roster_positions`; a bitmask dynamic program assigns each eligible player once across overlapping/repeated slots; unknown current starters are locked into their valid slot so missing projections can't create fake lineup improvements. Replacement level is the median of the best available players needed to satisfy per-team positional starter demand (fractional flex demand included); VOR is weekly projection minus replacement level. Transaction candidates are pruned to the strongest 10 adds per primary position and 14 non-starting drops (six of each for two-swaps); every candidate roster is re-solved through the exact lineup solver, and a league-derived decision band separates strong adds/upgrades from marginal churn and holds.

## Failure model

- Core Sleeper league/roster failures stop a run with an actionable error — Sleeper is the one source that must succeed.
- A Sleeper catalog refresh may fall back to its stale local copy, which is flagged stale.
- Every other source (crosswalk, each nflverse dataset, ESPN, each news feed) fails independently: on error, it first falls back to its last successful cached copy regardless of TTL, and only if there is no cache at all does it report `FAILED`/`TIMEOUT`/`BLOCKED`/`PARSE_ERROR` and contribute nothing for that run. Optimize always continues with whatever succeeded.
- Unknown Sleeper IDs remain visible by ID.
- Ambiguous player matches are rejected and shown in diagnostics.
- Unsupported scoring categories contribute no hidden points and are listed in the result.

The UI exposes timestamps (`Analysis started`, `Data retrieved through`), per-source status, coverage, mappings, unsupported keys, recommendation components, matchup/correlation reasoning, and snapshot history so results are reproducible from retained inputs.

## Target week (automatic)

Optimize picks one `targetWeek` and passes it to every provider (ESPN projections/rankings, nflverse schedule, injuries and usage, matchup and opponent lookup, free-agent evaluation, lineup solve, news, correlation, history, diagnostics, UI). It starts from Sleeper's week and advances to the next week only when every relevant game (active-roster players at fantasy positions) has already kicked off, judged by the scheduled kickoff instants in nflverse `games.csv` (Eastern wall clock converted to UTC; reschedules follow the new time; no published time counts as unplayed until end of gameday). Bye-week or teamless players do not keep the current week active. It never advances outside the regular season or if the schedule has no games for the next week. The next-week matchup is fetched from Sleeper for that week; if unpublished, the roster is still optimized and opponent analysis is shown as unavailable. See `server/engine/target-week.ts`.

## Waiver and add/drop decisions

**Default is HOLD.** With rolling waivers a successful claim sends the manager to the back of the priority line, so a move must earn its cost. Every candidate swap (all single add/drop pairs and a bounded set of two-player pairs, with the lineup fully re-solved) is priced by `assessTransaction` in `server/engine/waiver.ts`; the search in `server/engine/optimizer.ts` recommends the best candidate only if it reaches CLAIM or STRONG CLAIM. "Do nothing" is always a candidate: if nothing clears the bar the app reports **"No waiver claim recommended."** with the best alternative it rejected and why. The lineup solver itself is unchanged.

All numbers are league-scored expected points for one week and live in `WAIVER_MODEL` (tests import it):

```
net = adjustedWeeklyGain + longTermCredit + rosterNeedCredit − dropCost − waiverCost
adjustedWeeklyGain = weeklyGain × inputQuality × rolePersistence      (only when gain > 0)
```

- **Weekly gain**: difference in availability-weighted expected total between the best lineup with and without the swap. `inputQuality` = 0.75 + 0.25 × projection coverage (× 0.9 if either player's ID mapping is not exact/high).
- **Long-term value**: ESPN exposes no rest-of-season projection, so it is normally **unavailable**. It is never assumed to be zero and never invented: the claim/strong thresholds rise by +1/+2 ("insufficient long-term evidence"), and the weekly gain is multiplied by a role-persistence factor instead (DURABLE 1.5, MODERATE 1.2, UNKNOWN 1.0, LIMITED 0.9, TEMPORARY_FILL_IN 0.8; `server/engine/role.ts`). That factor is context about how long a role tends to last, not a projection. If a ROS value ever exists for both players, it is credited at `rosDiscount` (0.5) over a 4-week horizon and the persistence factor is dropped.
- **Role evidence** (`role.ts`): nflverse depth-chart rank, last-game offensive snap %, last-game carries/targets, and whether a teammate ahead on the depth chart is OUT/IR/PUP/suspended/doubtful (that makes the add a TEMPORARY_FILL_IN). Role also shifts the claim threshold (durable −0.5, temporary +1, limited/unknown +0.5).
- **Drop cost**: starting-caliber value (up to 2 pts, scaling with how close the drop projects to your weakest eligible starter), role value (DURABLE 1.0, MODERATE 0.5), and depth loss (1.5 per position left below a starter-plus-cushion count QB1/RB3/WR3/TE1/K1/DEF1, counting only players active and not on bye — this is the injury/bye insurance term). The reasoning text lists each component.
- **Roster need credit**: 2 pts per depth slot the add fills that is currently short (max 2 slots). This is how an injury hole or a bye-week gap can justify a small-gain move.
- **Waiver cost**: 0 for an instant free-agent add; otherwise `3 × priorityFactor`, where priorityFactor runs from 1.0 (you are first in line — spending it is expensive) down to 0.6 (last in line — little to lose). Unknown acquisition status is priced as a claim.
- **Thresholds** (not one fixed number): optional 1.5, claim 3, strong 6, then adjusted by the items above and +0.5 more when confidence is Low. STRONG additionally requires either ROS evidence or a role that is not a temporary fill-in/limited. The output shows the exact required value and the weekly gain that would break even (`breakEvenWeeklyGain`).
- **Tiers**: STRONG CLAIM ≥ strong; CLAIM ≥ claim; OPTIONAL ≥ optional; SPECULATIVE = below optional but nearly free to drop, add is not hurting the week, and a teammate ahead of them is injured (a lottery ticket); HOLD = otherwise; AVOID = net ≤ −2 or the add is not expected to play. Only CLAIM and STRONG CLAIM are recommended.

Consequences: a +2 weekly gain with no ROS never clears the bar; a +3 to +4 gain needs a worthless drop, a durable role, or a free-agent add; a large gain (roughly +8 or more against a mid-priority claim) clears it even with unknown ROS.

**Waiver claim vs free-agent add.** Sleeper's API has no per-player "on waivers" flag, so it is inferred and labeled as an inference: (1) a player dropped by any team within `waiver_clear_days` (default 2) is a claim; (2) a player whose NFL team already kicked off in *Sleeper's current week* (not the advanced target week) is held until the weekly waiver run, which matches this league's history (claims processed Sun–Tue, instant adds Wed–Sat); (3) otherwise a free-agent add. If league transactions cannot be loaded the status is UNKNOWN and priced like a claim. Waiver type, clear days and your `waiver_position` come from the league and roster settings; the UI shows them.
