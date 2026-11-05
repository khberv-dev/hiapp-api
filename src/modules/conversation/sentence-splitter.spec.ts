import { SentenceSplitter } from './sentence-splitter.js';

function splitAll(
  chunks: string[],
  opts?: ConstructorParameters<typeof SentenceSplitter>[0],
): string[] {
  const s = new SentenceSplitter(opts);
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

  describe('first chunk cut at a clause boundary', () => {
    const fast = { minChars: 20, firstChunkMaxChars: 60 };

    it('cuts a long first sentence at its last comma past minChars', () => {
      const words =
        "Well, that's a great question about travel, and I think the best time to visit is spring. " +
        'Later sentences, even long ones with commas, stay whole until they end.';
      // Stream word by word, like an LLM.
      const chunks = words.split(/(?<= )/);
      expect(splitAll(chunks, fast)).toEqual([
        "Well, that's a great question about travel,",
        'and I think the best time to visit is spring.',
        'Later sentences, even long ones with commas, stay whole until they end.',
      ]);
    });

    it('does not cut before a sentence end shorter than the limit', () => {
      expect(
        splitAll(['Oh, I see. ', 'That makes sense, honestly.'], fast),
      ).toEqual(['Oh, I see. That makes sense, honestly.']);
    });

    it('still never splits decimals or abbreviations', () => {
      expect(
        splitAll(
          [
            'Mr. Smith said the price was 3.5 dollars per kilo ',
            'in the market yesterday afternoon. Okay then, bye.',
          ],
          fast,
        ),
      ).toEqual([
        'Mr. Smith said the price was 3.5 dollars per kilo in the market yesterday afternoon.',
        'Okay then, bye.',
      ]);
    });
  });
});
