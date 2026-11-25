import { describe, expect, it } from 'vitest';
import { hasTimedText, lyricsHash, parseLrc, parsePlain } from './lrc.ts';

describe('parseLrc', () => {
  it('reads timestamps with centiseconds, milliseconds and tenths', () => {
    const lines = parseLrc('[00:01.50]a\n[00:02.123]b\n[00:03.5]c\n[01:04]d');
    expect(lines.map((l) => l.startMs)).toEqual([1500, 2123, 3500, 64000]);
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('expands multiple timestamps on the same line and sorts them', () => {
    const lines = parseLrc('[00:10.00][00:30.00]refrão\n[00:20.00]verso');
    expect(lines.map((l) => [l.startMs, l.text])).toEqual([
      [10000, 'refrão'],
      [20000, 'verso'],
      [30000, 'refrão'],
    ]);
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('empty timed lines become pauses, and consecutive pauses merge', () => {
    const lines = parseLrc('[00:01.00]um\n[00:05.00]\n[00:06.00]\n[00:09.00]dois');
    expect(lines.map((l) => l.text)).toEqual(['um', '', 'dois']);
    expect(lines[1]!.startMs).toBe(5000);
  });

  it('computes endMs from the next line and from the duration', () => {
    const lines = parseLrc('[00:01.00]um\n[00:04.00]dois', 10_000);
    expect(lines[0]!.endMs).toBe(4000);
    expect(lines[1]!.endMs).toBe(10_000);
  });

  it('ignores metadata and honors [offset]', () => {
    const lines = parseLrc('[ar:Artista]\n[ti:Título]\n[offset:+500]\n[00:02.00]linha');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startMs).toBe(1500);
  });

  it('strips enhanced-LRC word tags and ignores untimed lines', () => {
    const lines = parseLrc('crédito sem tempo\n[00:01.00]<00:01.00>Olá <00:01.50>mundo');
    expect(lines.map((l) => l.text)).toEqual(['Olá mundo']);
  });

  it('accepts CRLF and spaces between tags', () => {
    const lines = parseLrc('[00:01.00] [00:02.00] eco\r\n');
    expect(lines.map((l) => l.startMs)).toEqual([1000, 2000]);
  });

  it('hasTimedText requires at least one line with text', () => {
    expect(hasTimedText(parseLrc('[00:01.00]\n[00:02.00]'))).toBe(false);
    expect(hasTimedText(parseLrc('[00:01.00]oi'))).toBe(true);
  });
});

describe('parsePlain', () => {
  it('keeps a single empty line between stanzas and trims the edges', () => {
    const lines = parsePlain('\n\nverso 1\nverso 2\n\n\n\nverso 3\n\n');
    expect(lines.map((l) => l.text)).toEqual(['verso 1', 'verso 2', '', 'verso 3']);
    expect(lines.every((l) => l.startMs === null)).toBe(true);
  });
});

describe('lyricsHash', () => {
  it('depends only on the text', () => {
    const a = parseLrc('[00:01.00]oi\n[00:02.00]tchau');
    const b = parseLrc('[00:03.00]oi\n[00:09.00]tchau');
    expect(lyricsHash(a)).toBe(lyricsHash(b));
    expect(lyricsHash(a)).not.toBe(lyricsHash(parseLrc('[00:01.00]oi')));
  });
});
