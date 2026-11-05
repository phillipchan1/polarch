/**
 * Tool inputs: one declaration that is both the JSON Schema a client shows its
 * model and the validator that runs on every call.
 *
 * Deliberately strict. An unknown key is an error that names the keys that
 * exist, because the likeliest cause is a model guessing a parameter, and the
 * message is the only thing it will learn from.
 */

export type JsonSchema = Record<string, unknown>;

export class ArgError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ArgError";
    this.path = path;
  }
}

export interface Parser<T, Optional extends boolean = false> {
  readonly json: JsonSchema;
  readonly optional: Optional;
  parse(value: unknown, path: string): T;
}

type AnyParser = Parser<unknown, boolean>;
type Shape = Record<string, AnyParser>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Parser<unknown, true> ? K : never;
}[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;
type ValueOf<P> = P extends Parser<infer T, boolean> ? T : never;
export type Infer<P> = P extends Parser<infer T, boolean> ? T : never;

type ObjectOut<S extends Shape> = {
  [K in RequiredKeys<S>]: ValueOf<S[K]>;
} & {
  [K in OptionalKeys<S>]?: Exclude<ValueOf<S[K]>, undefined>;
};

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

type Described = { description?: string };

export function str(o: Described & { min?: number; max?: number } = {}): Parser<string> {
  return {
    optional: false,
    json: {
      type: "string",
      ...(o.description ? { description: o.description } : {}),
      ...(o.min !== undefined ? { minLength: o.min } : {}),
      ...(o.max !== undefined ? { maxLength: o.max } : {}),
    },
    parse(value, path) {
      if (typeof value !== "string") throw new ArgError(path, `expected a string, got ${describe(value)}.`);
      if (o.min !== undefined && value.trim().length < o.min) {
        throw new ArgError(path, o.min === 1 ? "can't be empty." : `needs at least ${o.min} characters.`);
      }
      if (o.max !== undefined && value.length > o.max) {
        throw new ArgError(path, `is too long (max ${o.max} characters).`);
      }
      return value;
    },
  };
}

export function enumOf<const T extends readonly string[]>(
  values: T,
  o: Described = {},
): Parser<T[number]> {
  return {
    optional: false,
    json: { type: "string", enum: [...values], ...(o.description ? { description: o.description } : {}) },
    parse(value, path) {
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ArgError(path, `must be one of ${values.map((v) => `"${v}"`).join(", ")}.`);
      }
      return value as T[number];
    },
  };
}

/** A real calendar date, YYYY-MM-DD. */
export function date(o: Described = {}): Parser<string> {
  return {
    optional: false,
    json: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: `${o.description ? `${o.description} ` : ""}Format YYYY-MM-DD.`,
    },
    parse(value, path) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new ArgError(path, `expected a date like 2026-11-05, got ${JSON.stringify(value)}.`);
      }
      const d = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
        throw new ArgError(path, `${value} isn't a real date.`);
      }
      return value;
    },
  };
}

export function int(o: Described & { min?: number; max?: number } = {}): Parser<number> {
  return {
    optional: false,
    json: {
      type: "integer",
      ...(o.description ? { description: o.description } : {}),
      ...(o.min !== undefined ? { minimum: o.min } : {}),
      ...(o.max !== undefined ? { maximum: o.max } : {}),
    },
    parse(value, path) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ArgError(path, `expected a whole number, got ${describe(value)}.`);
      }
      if (o.min !== undefined && value < o.min) throw new ArgError(path, `must be at least ${o.min}.`);
      if (o.max !== undefined && value > o.max) throw new ArgError(path, `must be at most ${o.max}.`);
      return value;
    },
  };
}

export function bool(o: Described = {}): Parser<boolean> {
  return {
    optional: false,
    json: { type: "boolean", ...(o.description ? { description: o.description } : {}) },
    parse(value, path) {
      if (typeof value !== "boolean") throw new ArgError(path, `expected true or false, got ${describe(value)}.`);
      return value;
    },
  };
}

export function arr<T>(
  item: Parser<T, boolean>,
  o: Described & { min?: number; max?: number } = {},
): Parser<T[]> {
  return {
    optional: false,
    json: {
      type: "array",
      items: item.json,
      ...(o.description ? { description: o.description } : {}),
      ...(o.min !== undefined ? { minItems: o.min } : {}),
      ...(o.max !== undefined ? { maxItems: o.max } : {}),
    },
    parse(value, path) {
      if (!Array.isArray(value)) throw new ArgError(path, `expected an array, got ${describe(value)}.`);
      if (o.min !== undefined && value.length < o.min) throw new ArgError(path, `needs at least ${o.min} item(s).`);
      if (o.max !== undefined && value.length > o.max) throw new ArgError(path, `takes at most ${o.max} items.`);
      return value.map((v, i) => item.parse(v, `${path}[${i}]`));
    },
  };
}

export function obj<S extends Shape>(shape: S, o: Described = {}): Parser<ObjectOut<S>> {
  const keys = Object.keys(shape);
  return {
    optional: false,
    json: {
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, shape[k].json])),
      required: keys.filter((k) => !shape[k].optional),
      additionalProperties: false,
      ...(o.description ? { description: o.description } : {}),
    },
    parse(value, path) {
      if (value === undefined || value === null) value = {};
      if (typeof value !== "object" || Array.isArray(value)) {
        throw new ArgError(path, `expected an object, got ${describe(value)}.`);
      }
      const input = value as Record<string, unknown>;
      const extra = Object.keys(input).filter((k) => !keys.includes(k));
      if (extra.length) {
        throw new ArgError(
          path,
          `unknown ${extra.length === 1 ? "parameter" : "parameters"} ${extra.map((k) => `"${k}"`).join(", ")}. ` +
            `Accepted: ${keys.length ? keys.join(", ") : "(none)"}.`,
        );
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const at = path ? `${path}.${k}` : k;
        const raw = input[k];
        if (raw === undefined) {
          if (!shape[k].optional) throw new ArgError(at, "is required.");
          continue;
        }
        out[k] = shape[k].parse(raw, at);
      }
      return out as ObjectOut<S>;
    },
  };
}

/** The key may be left out. */
export function opt<T>(p: Parser<T, boolean>): Parser<T | undefined, true> {
  return { optional: true, json: p.json, parse: (v, path) => p.parse(v, path) };
}

/** `null` means "clear it" — distinct from leaving the key out, which means "leave it alone". */
export function nullable<T>(p: Parser<T, boolean>): Parser<T | null, boolean> {
  const t = p.json.type;
  return {
    optional: p.optional,
    json: { ...p.json, type: Array.isArray(t) ? [...t, "null"] : [t, "null"] },
    parse: (v, path) => (v === null ? null : p.parse(v, path)),
  };
}

/** Run a parser over raw tool arguments. Throws `ArgError`; a missing `arguments` is treated as `{}`. */
export function parseArgs<T>(parser: Parser<T, boolean>, raw: unknown): T {
  return parser.parse(raw, "");
}
