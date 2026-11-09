/**
 * Back/forward position of a cross-origin preview frame. Its navigations land in the top page's
 * joint session history, which only exposes `history.length`, so the position is inferred from
 * that length and from the steps the panel itself took. `base` must never fall below the frame's
 * real first entry, or Back would count entries that are not this frame's and leave Pi Web.
 */
export interface FrameHistory {
  /** Entries up to and including the frame's first page (its first load adds no entry). */
  base: number;
  /** Last observed `history.length`. */
  length: number;
  /** Entries of this frame behind the current one. */
  back: number;
  /** Entries of this frame ahead of the current one. */
  forward: number;
}

/**
 * A new frame starts at the current entry, at most the last one. After Back the history still
 * holds forward entries; `observeFrameHistory` lowers the base once a navigation drops them.
 */
export function startFrameHistory(length: number): FrameHistory {
  return { base: length, length, back: 0, forward: 0 };
}

/**
 * A changed length means a navigation to a new page, which is now the last entry. A shorter
 * history means it dropped forward entries, so it left from entry `length - 1`: the frame's first
 * page is no later than that. shortcut: navigations that keep the length (one step after Back)
 * or happen past the browser's 50-entry cap go unseen and only make Back more cautious; precise
 * tracking needs a script injected into the page.
 */
export function observeFrameHistory(state: FrameHistory, length: number): FrameHistory {
  if (length === state.length) return state;
  const base = length < state.length ? Math.min(state.base, length - 1) : state.base;
  return { base, length, back: Math.max(0, length - base), forward: 0 };
}

/**
 * The frame finished loading a page. Unless the history changed length since the previous load
 * (a new page) or the panel just stepped it, this was a reload or a step the panel did not see
 * (the page's own back link, a system back gesture): the position is unknown until the next new
 * page, so Back and Forward turn off. shortcut: SPA steps fire no load and stay unseen.
 */
export function loadFrameHistory(state: FrameHistory, length: number, lengthAtPreviousLoad: number, ownStep: boolean): FrameHistory {
  const seen = observeFrameHistory(state, length);
  if (ownStep || length !== lengthAtPreviousLoad) return seen;
  return { ...seen, back: 0, forward: 0 };
}

export function stepFrameHistory(state: FrameHistory, delta: -1 | 1): FrameHistory {
  if (delta < 0 ? !state.back : !state.forward) return state;
  return { ...state, back: state.back + delta, forward: state.forward - delta };
}
