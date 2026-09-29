import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

describe('csv parsing', () => {
  it('parses simple rows into header-keyed records', () => {
    expect(parseCsv('a,b,c\n1,2,3\n4,5,6')).toEqual([{ a: '1', b: '2', c: '3' }, { a: '4', b: '5', c: '6' }]);
  });

  it('handles quoted fields containing commas and escaped quotes', () => {
    const result = parseCsv('name,note\n"Smith, John","said ""hi"""');
    expect(result).toEqual([{ name: 'Smith, John', note: 'said "hi"' }]);
  });

  it('skips blank trailing rows', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([{ a: '1', b: '2' }]);
  });
});
