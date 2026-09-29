function tzOffsetMinutes(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instantMs));
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return Math.round((Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instantMs) / 60_000);
}

/** nflverse publishes kickoff as an Eastern-time wall clock (`gameday` + `gametime`); returns the true UTC instant as ISO. */
export function easternToIso(gameday: string, gametime: string): string | null {
  const [year, month, day] = gameday.split('-').map(Number);
  const [hour, minute] = gametime.split(':').map(Number);
  if ([year, month, day, hour, minute].some(value => !Number.isFinite(value))) return null;
  const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const guess = wallClockAsUtc - tzOffsetMinutes(wallClockAsUtc, 'America/New_York') * 60_000;
  return new Date(wallClockAsUtc - tzOffsetMinutes(guess, 'America/New_York') * 60_000).toISOString();
}
