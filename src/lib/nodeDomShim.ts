/**
 * Enough of a browser for Node checks that import the Zustand store.
 * Import this module before `useStore`.
 *
 * `fetch` hangs on purpose: hydrateAuth then never emits INITIAL_SESSION, so
 * bootstrap cannot wipe fixtures mid-check.
 */
const g = globalThis as typeof globalThis & {
  localStorage: Storage;
  window: Window & typeof globalThis;
  document: Document;
  navigator: Navigator;
};

if (typeof g.localStorage === "undefined") {
  const mem: Record<string, string> = Object.create(null);
  const api = {
    getItem: (k: string) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k: string, v: string) => {
      mem[k] = String(v);
    },
    removeItem: (k: string) => {
      delete mem[k];
    },
    clear: () => {
      for (const k of Object.keys(mem)) delete mem[k];
    },
    key: (i: number) => Object.keys(mem)[i] ?? null,
    get length() {
      return Object.keys(mem).length;
    },
  };
  g.localStorage = api as Storage;
}

const matchMedia = () =>
  ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

const history = {
  replaceState: () => undefined,
  pushState: () => undefined,
  go: () => undefined,
  back: () => undefined,
  forward: () => undefined,
  length: 1,
  state: {},
};

if (typeof g.window === "undefined") {
  g.window = {
    matchMedia,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    location: { origin: "http://localhost", href: "http://localhost/", pathname: "/" },
    history,
    localStorage: g.localStorage,
  } as unknown as Window & typeof globalThis;
} else {
  if (!g.window.matchMedia) g.window.matchMedia = matchMedia;
  if (!g.window.history) (g.window as unknown as { history: typeof history }).history = history;
}

if (typeof g.document === "undefined") {
  g.document = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    visibilityState: "visible",
  } as unknown as Document;
}

if (typeof g.navigator === "undefined") {
  g.navigator = { onLine: true } as Navigator;
}

g.fetch = (() => new Promise(() => undefined)) as typeof fetch;
