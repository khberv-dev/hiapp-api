const TERMINATORS = new Set(['.', '!', '?', '…']);
const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'st',
  'vs',
  'etc',
  'e.g',
  'i.e',
]);

/** A clause boundary: `,` `;` `:` or a dash, followed by whitespace. */
const CLAUSE = /[,;:\u2014\u2013](?=\s)/g;

export interface SentenceSplitterOptions {
  /** Fragments shorter than this are merged into the next one. */
  minChars?: number;
  /**
   * If the first chunk has no sentence end by this length, cut it at the
   * last clause boundary instead, so the first TTS request starts sooner.
   * Later chunks always end at sentences (better prosody).
   */
  firstChunkMaxChars?: number;
}

/**
 * Turns streamed LLM text into speakable sentences so TTS can start before the
 * whole answer is generated. Skips abbreviations ("Mr.", "e.g.") and decimals
 * ("3.5"), and merges fragments shorter than `minChars` into the next one.
 */
export class SentenceSplitter {
  private buffer = '';
  private pending = '';
  private emittedAny = false;
  private readonly minChars: number;
  private readonly firstChunkMaxChars: number;

  constructor({
    minChars = 20,
    firstChunkMaxChars = Infinity,
  }: SentenceSplitterOptions = {}) {
    this.minChars = minChars;
    this.firstChunkMaxChars = firstChunkMaxChars;
  }

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let end: number;
    while ((end = this.findBoundary()) > 0) {
      this.emit(this.buffer.slice(0, end), out);
      this.buffer = this.buffer.slice(end);
    }
    if (!this.emittedAny && (end = this.findFirstClauseCut()) > 0) {
      this.emit(this.buffer.slice(0, end), out);
      this.buffer = this.buffer.slice(end);
    }
    if (out.length > 0) this.emittedAny = true;
    return out;
  }

  flush(): string[] {
    const out: string[] = [];
    const rest = join(this.pending, this.buffer.trim());
    if (rest) out.push(rest);
    this.buffer = '';
    this.pending = '';
    return out;
  }

  private emit(raw: string, out: string[]): void {
    const merged = join(this.pending, raw.trim());
    if (merged.length < this.minChars) {
      this.pending = merged;
    } else {
      this.pending = '';
      out.push(merged);
    }
  }

  /**
   * For the first chunk only: once the text is at least `firstChunkMaxChars`
   * long without a sentence end, the index just past its last clause
   * boundary that leaves at least `minChars`, or -1.
   */
  private findFirstClauseCut(): number {
    const offset = this.pending ? this.pending.length + 1 : 0;
    if (offset + this.buffer.trim().length < this.firstChunkMaxChars) return -1;
    let cut = -1;
    for (const m of this.buffer.matchAll(CLAUSE)) {
      const end = m.index + 1;
      if (offset + this.buffer.slice(0, end).trim().length >= this.minChars)
        cut = end;
    }
    return cut;
  }

  /** Index just past the first sentence end, or -1. Needs the next char to decide. */
  private findBoundary(): number {
    const s = this.buffer;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\n') return i + 1;
      if (!TERMINATORS.has(s[i])) continue;
      let end = i + 1;
      while (
        end < s.length &&
        (TERMINATORS.has(s[end]) || `"')`.includes(s[end]))
      )
        end++;
      if (end >= s.length) return -1; // wait: "3." might become "3.5"
      if (!/\s/.test(s[end])) {
        i = end - 1; // dot inside a token: "3.5", "file.txt"
        continue;
      }
      if (s[i] === '.' && end === i + 1 && this.isAbbreviation(i)) continue;
      return end;
    }
    return -1;
  }

  private isAbbreviation(dot: number): boolean {
    let start = dot;
    while (start > 0 && !/\s/.test(this.buffer[start - 1])) start--;
    return ABBREVIATIONS.has(this.buffer.slice(start, dot).toLowerCase());
  }
}

function join(a: string, b: string): string {
  return a && b ? `${a} ${b}` : a || b;
}
