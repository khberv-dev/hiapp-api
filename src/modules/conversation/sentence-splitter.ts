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

/**
 * Turns streamed LLM text into speakable sentences so TTS can start before the
 * whole answer is generated. Skips abbreviations ("Mr.", "e.g.") and decimals
 * ("3.5"), and merges fragments shorter than `minChars` into the next one.
 */
export class SentenceSplitter {
  private buffer = '';
  private pending = '';

  constructor(private readonly minChars = 20) {}

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let end: number;
    while ((end = this.findBoundary()) > 0) {
      this.emit(this.buffer.slice(0, end), out);
      this.buffer = this.buffer.slice(end);
    }
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
