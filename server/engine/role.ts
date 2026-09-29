import type { RoleEvidence, RoleKind } from '../../shared/types.js';

export interface RoleInput {
  position: string | null;
  depthRank: number | null;
  snapPct: number | null;
  recentUsage: { carries: number; targets: number; week: string } | null;
  teammatesAhead: Array<{ name: string; status: string }>;
}

const ABSENT = new Set(['OUT', 'IR', 'PUP', 'SUSPENDED', 'DOUBTFUL']);

/** Multiplier on a positive one-week gain standing in for "how many weeks will this role plausibly last". Not a projection. */
export const ROLE_PERSISTENCE: Record<RoleKind, number> = { DURABLE: 1.5, MODERATE: 1.2, UNKNOWN: 1, LIMITED: 0.9, TEMPORARY_FILL_IN: 0.8 };

export function assessRole(input: RoleInput): RoleEvidence {
  const { depthRank, snapPct, teammatesAhead, recentUsage } = input;
  const absentAhead = teammatesAhead.filter(item => ABSENT.has(item.status));
  let kind: RoleKind;
  if (depthRank == null && snapPct == null) kind = 'UNKNOWN';
  else if (absentAhead.length && (depthRank == null || depthRank > 1)) kind = 'TEMPORARY_FILL_IN';
  else if (depthRank === 1) kind = snapPct != null && snapPct < 35 ? 'MODERATE' : 'DURABLE';
  else if (depthRank === 2) kind = snapPct != null && snapPct >= 50 ? 'MODERATE' : 'LIMITED';
  else kind = snapPct != null && snapPct >= 60 ? 'MODERATE' : 'LIMITED';

  const parts: string[] = [];
  if (depthRank != null) parts.push(`#${depthRank} on the ${input.position || 'position'} depth chart`);
  if (snapPct != null) parts.push(`${Math.round(snapPct)}% of offensive snaps last game`);
  const usage = recentUsage && (recentUsage.carries || recentUsage.targets) ? `${recentUsage.carries} carries / ${recentUsage.targets} targets in week ${recentUsage.week}` : null;
  if (usage) parts.push(usage);
  const ahead = teammatesAhead.filter(item => item.status !== 'ACTIVE');
  if (ahead.length) parts.push(`ahead of them: ${ahead.map(item => `${item.name} (${item.status})`).join(', ')}`);
  const verdict: Record<RoleKind, string> = {
    DURABLE: 'Looks like a durable role.',
    MODERATE: 'A real but shared or secondary role; persistence is plausible, not established.',
    TEMPORARY_FILL_IN: 'Value is tied to a teammate ahead of them being unavailable and may disappear when that player returns.',
    LIMITED: 'Limited role; recent production may not persist.',
    UNKNOWN: 'No depth-chart or snap data was found, so role durability is unknown.'
  };
  return { kind, depthRank, snapPct, recentUsage: usage, injuriesAhead: ahead, summary: `${parts.length ? `${parts.join('; ')}. ` : ''}${verdict[kind]}` };
}
