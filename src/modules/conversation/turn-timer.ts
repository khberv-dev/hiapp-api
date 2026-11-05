/**
 * Monotonic timestamps (ms since the final transcript) for one turn, logged
 * as one JSON line when the turn ends. Each mark keeps its first value.
 * Holds no transcript text.
 */
export class TurnTimer {
  private readonly t0 = performance.now();
  private readonly marks: Record<string, number> = {};
  private readonly served: Record<string, string> = {};
  private readonly extra: Record<string, number> = {};

  constructor(
    readonly turnId: number,
    readonly conversationId: string,
  ) {}

  mark(name: string): void {
    this.marks[name] ??= Math.round(performance.now() - this.t0);
  }

  has(name: string): boolean {
    return name in this.marks;
  }

  /** Records which provider entry served a stage (first one wins). */
  servedBy(stage: 'llm' | 'tts', provider: string): void {
    this.served[stage] ??= provider;
  }

  /** A measured value that isn't a timestamp, e.g. `finalLagMs`. */
  set(name: string, value: number): void {
    this.extra[name] = Math.round(value);
  }

  toJSON() {
    return {
      turnId: this.turnId,
      conversationId: this.conversationId,
      ...this.extra,
      ...this.marks,
      served: this.served,
    };
  }
}
