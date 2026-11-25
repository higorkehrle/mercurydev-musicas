import { describe, expect, it } from 'vitest';
import { chooseCandidate, cleanTitle, normalizeTitle, type CandidateRecord } from './match.ts';

let nextId = 1;
function rec(p: Partial<CandidateRecord>): CandidateRecord {
  return {
    id: nextId++,
    trackName: 'Song',
    artistName: 'Artist',
    albumName: 'Album',
    duration: 200,
    instrumental: false,
    plainLyrics: 'plain',
    syncedLyrics: '[00:01.00]synced',
    ...p,
  };
}

describe('title normalization', () => {
  it.each([
    ['Northern Lights - Remastered 2015', 'Northern Lights'],
    ['Glass Harbor (Remastered)', 'Glass Harbor'],
    ['Slow Comet (Live)', 'Slow Comet'],
    ['Linger (feat. Guest Artist)', 'Linger'],
    ['Song feat. Someone', 'Song'],
    ['Paper Lanterns - 2011 Mix', 'Paper Lanterns'],
    ['Orbit - Radio Edit', 'Orbit'],
    ['(I Don\'t Mind) Paper Moons', '(I Don\'t Mind) Paper Moons'],
  ])('%s → %s', (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });

  it('ignores accents, case and punctuation', () => {
    expect(normalizeTitle('Ruas de Março!')).toBe(normalizeTitle('ruas de marco'));
  });
});

describe('chooseCandidate', () => {
  const q = { trackName: 'Song - Remastered 2011', artists: ['Artist'], durationSec: 200 };

  it('prefers synced lyrics within ±2s', () => {
    const plainOnly = rec({ duration: 200, syncedLyrics: null });
    const synced = rec({ duration: 201.5 });
    const r = chooseCandidate(q, [plainOnly, synced]);
    expect(r?.record).toBe(synced);
    expect(r?.useSynced).toBe(true);
    expect(r?.warning).toBeNull();
  });

  it('among synced candidates, prefers the closest duration', () => {
    const far = rec({ duration: 201.9 });
    const near = rec({ duration: 200.2 });
    expect(chooseCandidate(q, [far, near])?.record).toBe(near);
  });

  it('rejects a different artist and an unrelated title', () => {
    expect(chooseCandidate(q, [rec({ artistName: 'Other' }), rec({ trackName: 'Different' })])).toBeNull();
  });

  it('accepts an artist with feat. in the candidate', () => {
    expect(chooseCandidate(q, [rec({ artistName: 'Artist feat. Guest' })])).not.toBeNull();
  });

  it('live version with a different duration: uses unsynced text and warns', () => {
    const live = { trackName: 'Song (Live)', artists: ['Artist'], durationSec: 260 };
    const r = chooseCandidate(live, [rec({ duration: 200 })]);
    expect(r?.useSynced).toBe(false);
    expect(r?.warning).toBe('duration_mismatch');
  });

  it('no synced lyrics and outside the duration: no warning', () => {
    const r = chooseCandidate(q, [rec({ duration: 250, syncedLyrics: null })]);
    expect(r?.useSynced).toBe(false);
    expect(r?.warning).toBeNull();
  });

  it('ignores candidates without lyrics that are not instrumental', () => {
    expect(chooseCandidate(q, [rec({ plainLyrics: null, syncedLyrics: null })])).toBeNull();
    expect(chooseCandidate(q, [rec({ plainLyrics: null, syncedLyrics: null, instrumental: true })])?.record.instrumental).toBe(true);
  });
});
