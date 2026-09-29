import { describe, expect, it } from 'vitest';
import { assessRole } from './role.js';

const base = { position: 'RB', recentUsage: null, teammatesAhead: [] as Array<{ name: string; status: string }> };

describe('role evidence', () => {
  it('marks a lead back with real snaps as durable', () => expect(assessRole({ ...base, depthRank: 1, snapPct: 65 }).kind).toBe('DURABLE'));

  it('marks a backup behind an unavailable starter as a temporary fill-in', () => {
    const role = assessRole({ ...base, depthRank: 2, snapPct: 52, teammatesAhead: [{ name: 'Starter', status: 'OUT' }] });
    expect(role.kind).toBe('TEMPORARY_FILL_IN');
    expect(role.summary).toContain('Starter (OUT)');
  });

  it('does not call a role durable without depth or snap data', () => expect(assessRole({ ...base, depthRank: null, snapPct: null }).kind).toBe('UNKNOWN'));

  it('treats a healthy teammate ahead as a normal secondary role', () => expect(assessRole({ ...base, depthRank: 2, snapPct: 55, teammatesAhead: [{ name: 'Starter', status: 'ACTIVE' }] }).kind).toBe('MODERATE'));
});
