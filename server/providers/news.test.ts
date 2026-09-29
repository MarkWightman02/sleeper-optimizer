import { describe, expect, it } from 'vitest';
import { decodeEntities, matchNewsByName, parseRss } from './news.js';
import type { NewsItem } from '../../shared/types.js';

const item = (headline: string, summary: string | null = null): NewsItem => ({ source: 'RotoBaller', headline, summary, url: null, publishedAt: '2026-09-28T12:00:00.000Z' });

describe('RSS parsing', () => {
  it('decodes entities and CDATA, strips markup, and keeps a real ISO publish time', () => {
    const xml = `<rss><channel><item><title><![CDATA[Ja&#8217;Marr Chase &amp; Tee Higgins]]></title><link>https://example.test/a</link><pubDate>Mon, 28 Sep 2026 12:00:00 +0000</pubDate><description><![CDATA[<p>Both &quot;fine&quot;.</p>]]></description></item></channel></rss>`;
    expect(parseRss(xml)).toEqual([{ source: 'RotoBaller', headline: 'Ja’Marr Chase & Tee Higgins', summary: 'Both "fine".', url: 'https://example.test/a', publishedAt: '2026-09-28T12:00:00.000Z' }]);
  });

  it('keeps an undated item undated instead of inventing a time', () => {
    expect(parseRss('<item><title>Undated</title></item>')[0].publishedAt).toBeNull();
    expect(decodeEntities('&#x41;&amp;&unknownentity;')).toBe('A&&unknownentity;');
  });
});

describe('news to player matching', () => {
  const players = [{ sleeperId: '1', name: 'Josh Allen' }, { sleeperId: '2', name: 'Josh Allen' }, { sleeperId: '3', name: 'Bo Nix' }, { sleeperId: '4', name: 'Nix' }, { sleeperId: '5', name: 'Chase Brown' }];

  it('matches whole names only and skips ambiguous duplicate names and single-word names', () => {
    const map = matchNewsByName([item('Bo Nix throws four TDs'), item('Josh Allen is questionable'), item('Nixon returns', 'Chase Browning speaks')], players);
    expect([...map.keys()]).toEqual(['3']);
  });

  it('matches names found in the summary and not embedded in a longer name', () => {
    const map = matchNewsByName([item('Waiver wire', 'Chase Brown leads the backfield'), item('Chase Browne signs')], players);
    expect(map.get('5')).toHaveLength(1);
  });
});
