# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0]

First release.

### Added
- **Sleeper read-only integration**: league discovery from a username, rosters, matchups and scoring settings. No password and no write endpoints.
- **Free public data pipeline**: no paid API and no API keys. Every volatile source is re-fetched on each run; cached data is used only as a clearly flagged stale fallback.
- **nflverse supporting data**: official injury reports, depth charts, snap counts and schedule.
- **ESPN projections and rankings**: weekly stat projections re-scored with the league's own Sleeper scoring, plus expert-panel ranks, with per-source provenance.
- **Injury-aware optimization**: availability-weighted expected points, explicit "availability override" explanations that state the exact projection given up.
- **Automatic target-week selection**: optimizes the upcoming week and advances after the current week's games finish.
- **Opponent matchup analysis**: side-by-side lineups, positional edges, uncertainty comparison and waiver context. No win probability is shown.
- **Correlation analysis**: QB/pass-catcher and defense/offense links, used only as a bounded tiebreaker on close decisions.
- **Conservative rolling-waiver logic**: transactions are recommended only when the evidence clears explicit thresholds; the default verdict is HOLD.
- **Source diagnostics and provenance**: per-source status and timestamps, player-ID mapping audit, and per-player evidence (raw stats, multipliers, rankings, news).
- **Docker deployment**: Compose service listening on `0.0.0.0:8009`, published as `8009:8009`, with a persistent named volume.
