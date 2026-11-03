import { SentenceSplitter } from './sentence-splitter.js';

function splitAll(chunks: string[]): string[] {
  const s = new SentenceSplitter();
  return [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
}

describe('SentenceSplitter', () => {
  it('splits streamed text into sentences', () => {
    expect(
      splitAll([
        'That sounds really fun',
        '! What did you ',
        'eat there? I love street food.',
      ]),
    ).toEqual([
      'That sounds really fun!',
      'What did you eat there?',
      'I love street food.',
    ]);
  });

  it('does not split abbreviations or decimals', () => {
    expect(
      splitAll([
        'Mr. Smith paid 3.',
        '5 dollars for it, e.g. a bargain. ',
        'Wow, really nice.',
      ]),
    ).toEqual([
      'Mr. Smith paid 3.5 dollars for it, e.g. a bargain.',
      'Wow, really nice.',
    ]);
  });

  it('merges short fragments into the next sentence', () => {
    expect(splitAll(['Oh nice! Where was that exactly?'])).toEqual([
      'Oh nice! Where was that exactly?',
    ]);
  });

  it('splits on newlines and flushes the remainder', () => {
    expect(
      splitAll(['First line of the answer\nand the unfinished rest']),
    ).toEqual(['First line of the answer', 'and the unfinished rest']);
  });
});
