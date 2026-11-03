/**
 * Starts consuming `source` immediately and buffers its items, so a later
 * consumer gets them without waiting. Used to synthesize the next sentence
 * while the current one is still being played.
 */
export function prefetch<T>(source: AsyncIterable<T>): AsyncIterable<T> {
  const items: T[] = [];
  let done = false;
  let error: unknown;
  let wake: (() => void) | undefined;

  void (async () => {
    try {
      for await (const item of source) {
        items.push(item);
        wake?.();
      }
    } catch (err) {
      error = err;
    } finally {
      done = true;
      wake?.();
    }
  })();

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length > 0) {
          yield items.shift() as T;
          continue;
        }
        if (error !== undefined) throw error;
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}
