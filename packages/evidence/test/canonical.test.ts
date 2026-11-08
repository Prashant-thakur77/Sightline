import { describe, expect, it } from 'vitest';
import { canonicalJson, CanonicalJsonError } from '../src';

function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe('canonicalJson: RFC 8785 known answers', () => {
  it('serialises the RFC 8785 primitive-data example exactly', () => {
    // JSON text exactly as printed in RFC 8785 section 3.2.2 (backslashes doubled for JS).
    const input = JSON.parse(
      '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001], ' +
        '"string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/", ' +
        '"literals": [null, true, false]}',
    );
    expect(input.string).toBe('\u20ac$\u000f\nA\'B"\\\\"/');
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 sorting example)', () => {
    const input = JSON.parse(
      '{"\\u20ac": "Euro Sign", "\\r": "Carriage Return", "\\ufb33": "Hebrew Letter Dalet With Dagesh", ' +
        '"1": "One", "\\ud83d\\ude00": "Emoji: Grinning Face", "\\u0080": "Control", ' +
        '"\\u00f6": "Latin Small Letter O With Diaeresis"}',
    );
    expect(Object.keys(input)).toHaveLength(7);
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it.each([
    ['0000000000000000', '0'],
    ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('formats IEEE-754 %s as %s', (bits, expected) => {
    expect(canonicalJson(fromBits(bits))).toBe(expected);
  });

  it('formats the everyday edge cases', () => {
    expect(canonicalJson(1e21)).toBe('1e+21');
    expect(canonicalJson(1e20)).toBe('100000000000000000000');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(0.1)).toBe('0.1');
    expect(canonicalJson(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(canonicalJson(1e-7)).toBe('1e-7');
    expect(canonicalJson([1.0, 100, -1.5])).toBe('[1,100,-1.5]');
  });
});

describe('canonicalJson: structure', () => {
  it('sorts nested keys at every level and keeps array order', () => {
    const v = { b: { z: 1, a: [3, { y: true, x: null }, 1] }, a: 'first' };
    expect(canonicalJson(v)).toBe('{"a":"first","b":{"a":[3,{"x":null,"y":true},1],"z":1}}');
  });

  it('is independent of insertion order', () => {
    expect(canonicalJson({ a: 1, b: 2, c: { d: 3, e: 4 } })).toBe(
      canonicalJson({ c: { e: 4, d: 3 }, b: 2, a: 1 }),
    );
  });

  it('emits no whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: { c: 'd e' } })).toBe('{"a":[1,2],"b":{"c":"d e"}}');
  });

  it('keeps non-ASCII text as raw UTF-8 and escapes control characters in lowercase hex', () => {
    expect(canonicalJson('naïve café 日本 😀')).toBe('"naïve café 日本 😀"');
    expect(canonicalJson('\u001f\u0000\b\t\n\f\r')).toBe('"\\u001f\\u0000\\b\\t\\n\\f\\r"');
    expect(canonicalJson('  ')).toBe('"  "');
    expect(canonicalJson('a"b\\c/d')).toBe('"a\\"b\\\\c/d"');
  });

  it('drops undefined object members', () => {
    expect(canonicalJson({ a: 1, b: undefined, c: { d: undefined } })).toBe('{"a":1,"c":{}}');
  });

  it('accepts null-prototype objects and repeated (non-cyclic) references', () => {
    const shared = { k: 1 };
    const bare = Object.assign(Object.create(null), { b: 2, a: 1 });
    expect(canonicalJson({ x: shared, y: shared, z: bare })).toBe('{"x":{"k":1},"y":{"k":1},"z":{"a":1,"b":2}}');
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined in an array', [1, undefined, 2]],
    ['a sparse array hole', [1, , 2]], // eslint-disable-line no-sparse-arrays
    ['top-level undefined', undefined],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate', '\udc00'],
    ['a lone surrogate in a key', { ['\ud800']: 1 }],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a Uint8Array', new Uint8Array(2)],
    ['a bigint', 10n],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it('refuses cycles and says where', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = { back: a };
    expect(() => canonicalJson(a)).toThrow(/Cycle detected at \$\.self\.back/);
  });
});
