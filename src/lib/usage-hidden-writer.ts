/**
 * Client-side writer for the hidden Usage card list.
 *
 * Writes go to the server one at a time, in the order they were made, so the
 * server applies them in that order and the newest write's response is the
 * whole stored list. Each change shows at once; only the newest write's
 * response (or its recovery read) replaces the list. A failed newest write
 * re-reads the stored list, and undoes only its own change if that read fails.
 */
export interface HiddenCardsWriterDeps {
  /** PUT { cards, hidden }; resolves to the stored list after the write. */
  send: (cards: string[], hidden: boolean) => Promise<string[]>;
  /** GET; resolves to the stored list. */
  reload: () => Promise<string[]>;
  setList: (update: (current: string[]) => string[]) => void;
  setError: (message: string | null) => void;
}

export interface HiddenCardsWriter {
  write: (cards: string[], hidden: boolean) => Promise<void>;
  /** True once any write was made: a first read that lands later must not replace the list. */
  started: () => boolean;
}

export function createHiddenCardsWriter(deps: HiddenCardsWriterDeps): HiddenCardsWriter {
  let seq = 0;
  let chain: Promise<void> = Promise.resolve();

  function write(cards: string[], hidden: boolean): Promise<void> {
    const mine = ++seq;
    const latest = () => mine === seq;
    const apply = (on: boolean) => (cur: string[]) => on ? [...new Set([...cur, ...cards])] : cur.filter((k) => !cards.includes(k));
    deps.setError(null);
    deps.setList(apply(hidden));

    const run = async () => {
      try {
        const list = await deps.send(cards, hidden);
        if (latest()) deps.setList(() => list);
      } catch {
        // A newer write is queued behind this one; its response is the stored list.
        if (!latest()) return;
        try {
          const list = await deps.reload();
          if (latest()) deps.setList(() => list);
        } catch {
          if (latest()) deps.setList(apply(!hidden));
        }
        if (latest()) deps.setError(hidden ? "Could not save: the box is shown again." : "Could not save: the boxes stay hidden.");
      }
    };
    const done = chain.then(run);
    chain = done.catch(() => {});
    return done;
  }

  return { write, started: () => seq > 0 };
}
