/**
 * Canonical JSON (RFC 8785 subset).
 *
 * One definition of "what these bytes are" for every hash in Sightline:
 * - object keys sorted by UTF-16 code units, no whitespace;
 * - numbers in ECMAScript shortest round-trip form (so -0 becomes 0, 1e21 becomes 1e+21);
 * - strings escaped the way JSON.stringify does it (\b \t \n \f \r \" \\ and \u00xx for other
 *   control characters, lowercase hex), everything else emitted as raw UTF-8;
 * - undefined object members are dropped, everything else that is not JSON is an error.
 *
 * Inputs that would make two different values serialise the same way, or the same value
 * serialise two ways, are refused instead of guessed at: NaN, Infinity, lone surrogates,
 * undefined inside arrays, functions, symbols, bigints, Dates, Maps, typed arrays, cycles.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export class CanonicalJsonError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
    this.path = path;
  }
}

function isWellFormedUtf16(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function serialiseString(s: string, path: string): string {
  if (!isWellFormedUtf16(s)) throw new CanonicalJsonError('String contains a lone surrogate', path);
  // JSON.stringify on a well-formed string produces exactly the RFC 8785 escaping.
  return JSON.stringify(s);
}

function serialiseNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) throw new CanonicalJsonError(`Number ${n} is not valid JSON`, path);
  // ES Number::toString is the RFC 8785 number format; JSON.stringify(-0) is "0".
  return JSON.stringify(n);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialise(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serialiseNumber(value, path);
    case 'string':
      return serialiseString(value, path);
    case 'undefined':
      throw new CanonicalJsonError('undefined is not valid JSON here', path);
    case 'bigint':
      throw new CanonicalJsonError('bigint is not valid JSON', path);
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${typeof value} is not valid JSON`, path);
    case 'object':
      break;
  }

  const obj = value as object;
  if (ancestors.has(obj)) throw new CanonicalJsonError('Cycle detected', path);

  if (Array.isArray(obj)) {
    ancestors.add(obj);
    const parts: string[] = [];
    for (let i = 0; i < obj.length; i++) {
      // Holes in sparse arrays read as undefined and are refused too.
      parts.push(serialise(obj[i], `${path}[${i}]`, ancestors));
    }
    ancestors.delete(obj);
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(obj)) {
    const kind = (obj as { constructor?: { name?: string } }).constructor?.name ?? 'object';
    throw new CanonicalJsonError(`${kind} is not a plain JSON object`, path);
  }

  ancestors.add(obj);
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareUtf16);
  const parts: string[] = [];
  for (const key of keys) {
    const v = record[key];
    if (v === undefined) continue;
    const childPath = `${path}.${key}`;
    parts.push(`${serialiseString(key, childPath)}:${serialise(v, childPath, ancestors)}`);
  }
  ancestors.delete(obj);
  return `{${parts.join(',')}}`;
}

/** Deterministic RFC 8785-style serialisation. Throws CanonicalJsonError on non-JSON input. */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$', new Set());
}
