import { Art } from './art';

/*
 * The product's own drawings: everyday objects from shopping on your own (a parcel, a size tag,
 * a receipt, a phone that listens, a mug on the table). Fills sit under the lines, offset a few
 * pixels. Every line has pathLength 1 so it can draw in; --i orders the drawing.
 */

type P = { className?: string; label?: string; delay?: number };
const i = (n: number) => ({ ['--i' as string]: n }) as React.CSSProperties;

/** Landing hero: an opened parcel with the sweater inside, its size tag out, a phone listening. */
export function HeroArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 560 470" className={className} label={label} delay={delay}>
      <ellipse className="fb" cx="300" cy="432" rx="230" ry="20" opacity="0.7" />
      <g className="off">
        <path className="fb" d="M170 262 H400 V410 H170 Z" />
        <path className="fp" d="M400 262 L448 220 V372 L400 410 Z" />
        <path className="fa" d="M214 262 C222 214 258 202 300 205 C342 202 378 214 386 262 Z" />
        <rect className="fc" x="272" y="262" width="30" height="62" rx="3" />
        <path className="fc" d="M316 238 l20 -6 l9 26 l-20 6 l-9 -9 Z" />
        <rect className="fb" x="76" y="338" width="64" height="72" rx="12" />
        <rect className="fp" x="452" y="150" width="76" height="138" rx="16" transform="rotate(9 490 219)" />
      </g>
      {/* parcel */}
      <path className="ln" pathLength={1} style={i(0)} d="M170 262 H400 V410 H170 Z" />
      <path className="ln" pathLength={1} style={i(1)} d="M400 262 L448 220 V372 L400 410" />
      <path className="ln" pathLength={1} style={i(2)} d="M170 262 L214 222 H448" />
      <path className="ln" pathLength={1} style={i(3)} d="M170 262 L118 236 L160 196 L214 222" />
      <path className="ln" pathLength={1} style={i(4)} d="M448 220 L498 208 L470 250 L400 262" />
      <path className="ln" pathLength={1} style={i(5)} d="M272 262 V324 H302 V262" />
      {/* the sweater inside, folded */}
      <path className="ln" pathLength={1} style={i(6)} d="M214 262 C222 214 258 202 300 205 C342 202 378 214 386 262" />
      <path className="ln" pathLength={1} style={i(7)} d="M276 207 Q300 230 324 207" />
      <path className="ln ln-thin" pathLength={1} style={i(8)} d="M236 246 q6 -10 0 -20 M252 246 q6 -10 0 -20 M352 246 q-6 -10 0 -20 M368 246 q-6 -10 0 -20" />
      {/* size tag on a thread */}
      <path className="ln ln-thin" pathLength={1} style={i(9)} d="M300 222 Q304 236 316 238" />
      <path className="ln" pathLength={1} style={i(10)} d="M316 238 l20 -6 l9 26 l-20 6 l-9 -9 Z" />
      <circle className="ln ln-thin" pathLength={1} style={i(11)} cx="324" cy="242" r="2.5" />
      {/* mug, with steam */}
      <path className="ln" pathLength={1} style={i(12)} d="M76 338 H140 V398 Q140 410 128 410 H88 Q76 410 76 398 Z" />
      <path className="ln" pathLength={1} style={i(13)} d="M140 352 h10 a14 14 0 0 1 0 28 h-10" />
      <path className="ln ln-thin wave" pathLength={1} style={i(14)} d="M96 326 q-8 -12 0 -24 q8 -12 0 -24" />
      <path className="ln ln-thin wave" pathLength={1} style={i(15)} d="M118 326 q-8 -12 0 -24 q8 -12 0 -24" />
      {/* the phone, listening */}
      <g transform="rotate(9 490 219)">
        <rect className="ln" pathLength={1} style={i(16)} x="452" y="150" width="76" height="138" rx="16" />
        <path className="ln ln-thin" pathLength={1} style={i(17)} d="M480 274 h20" />
        <rect className="ln ln-thin" pathLength={1} style={i(18)} x="482" y="190" width="16" height="30" rx="8" />
        <path className="ln ln-thin" pathLength={1} style={i(19)} d="M476 212 a14 14 0 0 0 28 0 M490 226 v10" />
      </g>
      <path className="ln wave" pathLength={1} style={i(20)} d="M440 132 q-14 -18 2 -38" />
      <path className="ln wave" pathLength={1} style={i(21)} d="M420 140 q-26 -30 4 -64" />
      <path className="ln wave" pathLength={1} style={i(22)} d="M398 150 q-38 -44 6 -94" />
      {/* braille cells: decoration */}
      <g className="pop" style={i(0)}>
        <circle className="fi" cx="96" cy="120" r="6" />
        <circle className="fi" cx="96" cy="140" r="6" />
        <circle className="fi" cx="116" cy="140" r="6" />
        <circle className="ln ln-thin" cx="116" cy="120" r="5" />
        <circle className="ln ln-thin" cx="96" cy="160" r="5" />
        <circle className="fi" cx="116" cy="160" r="6" />
      </g>
      <g className="pop" style={i(1)}>
        <circle className="fi" cx="146" cy="120" r="6" />
        <circle className="ln ln-thin" cx="166" cy="120" r="5" />
        <circle className="fi" cx="146" cy="140" r="6" />
        <circle className="fi" cx="166" cy="140" r="6" />
        <circle className="ln ln-thin" cx="146" cy="160" r="5" />
        <circle className="ln ln-thin" cx="166" cy="160" r="5" />
      </g>
      <path className="ln ln-thin pop" style={i(2)} d="M372 160 v16 M364 168 h16" />
      <path className="ln ln-thin pop" style={i(3)} d="M214 150 v12 M208 156 h12" />
    </Art>
  );
}

/** 1. Ask: you say what you need; the phone listens. */
export function AskArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <rect className="fb" x="122" y="40" width="78" height="150" rx="16" />
        <path className="fc" d="M30 40 H112 Q122 40 122 50 V82 Q122 92 112 92 H62 L46 106 V92 H30 Q20 92 20 82 V50 Q20 40 30 40 Z" />
        <circle className="fa" cx="161" cy="104" r="24" />
      </g>
      <rect className="ln" pathLength={1} style={i(0)} x="122" y="40" width="78" height="150" rx="16" />
      <path className="ln ln-thin" pathLength={1} style={i(1)} d="M151 176 h20" />
      <rect className="ln" pathLength={1} style={i(2)} x="153" y="86" width="16" height="30" rx="8" />
      <path className="ln" pathLength={1} style={i(3)} d="M146 106 a15 15 0 0 0 30 0 M161 121 v10" />
      <path className="ln" pathLength={1} style={i(4)} d="M30 40 H112 Q122 40 122 50 V82 Q122 92 112 92 H62 L46 106 V92 H30 Q20 92 20 82 V50 Q20 40 30 40 Z" />
      <path className="ln ln-thin" pathLength={1} style={i(5)} d="M36 58 H104 M36 74 H84" />
      <path className="ln wave" pathLength={1} style={i(6)} d="M214 92 q14 24 0 48" />
      <path className="ln wave" pathLength={1} style={i(7)} d="M232 80 q24 36 0 72" />
      <path className="ln wave" pathLength={1} style={i(8)} d="M250 68 q34 48 0 96" />
    </Art>
  );
}

/** 2. Hear it back: a receipt read aloud, word for word, before anything is paid. */
export function ReadbackArt({ className, label, delay }: P) {
  const zig = 'M112 34 H212 V180 l-10 9 l-10 -9 l-10 9 l-10 -9 l-10 9 l-10 -9 l-10 9 l-10 -9 l-10 9 l-10 -9 Z';
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <path className="fb" d={zig} />
        <circle className="fa" cx="222" cy="168" r="22" />
        <path className="fc" d="M40 104 H58 L78 86 V146 L58 128 H40 Z" />
      </g>
      <path className="ln" pathLength={1} style={i(0)} d={zig} />
      <path className="ln ln-thin" pathLength={1} style={i(1)} d="M128 58 H196 M128 76 H180 M128 94 H190 M128 112 H170" />
      <path className="ln ln-thin ln-dash" d="M128 130 H196" />
      <path className="ln" pathLength={1} style={i(2)} d="M128 150 H158 M174 150 H196" />
      <circle className="ln" pathLength={1} style={i(3)} cx="222" cy="168" r="22" />
      <path className="ln" pathLength={1} style={i(4)} d="M212 168 l7 7 l14 -15" />
      <path className="ln" pathLength={1} style={i(5)} d="M40 104 H58 L78 86 V146 L58 128 H40 Z" />
      <path className="ln wave" pathLength={1} style={i(6)} d="M88 102 q8 14 0 28" />
      <path className="ln wave" pathLength={1} style={i(7)} d="M98 94 q14 22 0 44" />
    </Art>
  );
}

/** 3. PayPal holds the money: it waits, safe, until you have checked the parcel. */
export function HoldArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <rect className="fb" x="78" y="64" width="160" height="132" rx="30" />
        <circle className="fc" cx="158" cy="132" r="38" />
        <circle className="fa" cx="242" cy="62" r="24" />
      </g>
      <rect className="ln" pathLength={1} style={i(0)} x="78" y="64" width="160" height="132" rx="30" />
      <path className="ln" pathLength={1} style={i(1)} d="M134 64 V50 a24 24 0 0 1 48 0 V64" />
      <circle className="ln" pathLength={1} style={i(2)} cx="158" cy="132" r="38" />
      <circle className="ln ln-thin" pathLength={1} style={i(3)} cx="158" cy="132" r="27" />
      <path className="ln" pathLength={1} style={i(4)} d="M148 120 h20 M148 132 h20 M148 144 h20" />
      <circle className="ln" pathLength={1} style={i(5)} cx="242" cy="62" r="24" />
      <path className="ln" pathLength={1} style={i(6)} d="M242 48 V62 L252 70" />
    </Art>
  );
}

/** 4. Check it: the camera looks at what arrived, and reads the size tag. */
export function CheckArt({ className, label, delay }: P) {
  const sweater = 'M104 98 L144 76 H176 L216 98 L234 144 L210 154 L196 124 V206 H124 V124 L110 154 L86 144 Z';
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <path className="fa" d={sweater} />
        <rect className="fc" x="152" y="84" width="16" height="22" rx="3" />
      </g>
      <path className="ln" pathLength={1} style={i(0)} d={sweater} />
      <path className="ln" pathLength={1} style={i(1)} d="M144 76 Q160 94 176 76" />
      <rect className="ln" pathLength={1} style={i(2)} x="152" y="84" width="16" height="22" rx="3" />
      <path className="ln ln-thin" pathLength={1} style={i(3)} d="M130 196 h60" />
      <path className="ln" pathLength={1} style={i(4)} d="M64 60 V40 H86 M234 40 H256 V60 M256 196 V218 H234 M86 218 H64 V196" />
      <circle className="ln ln-thin ln-dash" cx="160" cy="95" r="24" />
    </Art>
  );
}

/** 5. Money back: the hold is released, or PayPal refunds, and the money comes home. */
export function RefundArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <rect className="fb" x="124" y="112" width="132" height="88" rx="18" />
        <circle className="fc" cx="84" cy="74" r="24" />
      </g>
      <rect className="ln" pathLength={1} style={i(0)} x="124" y="112" width="132" height="88" rx="18" />
      <path className="ln" pathLength={1} style={i(1)} d="M124 136 H230 Q244 136 244 150 V162 Q244 176 230 176 H206 Q192 176 192 162 V150 Q192 136 206 136" />
      <circle className="ln ln-thin" pathLength={1} style={i(2)} cx="216" cy="156" r="4" />
      <circle className="ln" pathLength={1} style={i(3)} cx="84" cy="74" r="24" />
      <path className="ln ln-thin" pathLength={1} style={i(4)} d="M76 68 h16 M76 80 h16" />
      <path className="ln" pathLength={1} style={i(5)} d="M108 70 Q170 40 196 100" />
      <path className="ln" pathLength={1} style={i(6)} d="M184 92 L196 100 L202 86" />
      <path className="ln ln-thin pop" style={i(0)} d="M262 92 v14 M255 99 h14" />
      <path className="ln ln-thin pop" style={i(1)} d="M60 150 v10 M55 155 h10" />
    </Art>
  );
}

/** Your agent: one thread of steps, each a dot, done for you while you get on with your day. */
export function AgentArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <circle className="fa" cx="70" cy="70" r="20" />
        <circle className="fb" cx="160" cy="120" r="20" />
        <circle className="fc" cx="250" cy="70" r="20" />
        <circle className="fb" cx="250" cy="180" r="20" />
      </g>
      <path className="ln ln-dash" d="M88 78 L142 112 M178 112 L232 78 M250 92 V158" />
      <circle className="ln" pathLength={1} style={i(0)} cx="70" cy="70" r="20" />
      <circle className="ln" pathLength={1} style={i(1)} cx="160" cy="120" r="20" />
      <circle className="ln" pathLength={1} style={i(2)} cx="250" cy="70" r="20" />
      <circle className="ln" pathLength={1} style={i(3)} cx="250" cy="180" r="20" />
      <path className="ln" pathLength={1} style={i(4)} d="M62 70 l6 6 l11 -12" />
      <path className="ln" pathLength={1} style={i(5)} d="M152 120 l6 6 l11 -12" />
      <path className="ln" pathLength={1} style={i(6)} d="M242 70 l6 6 l11 -12" />
      <circle className="fi pop" style={i(0)} cx="250" cy="180" r="5" />
    </Art>
  );
}

/** A store's counter: the other side of the case, with its own agent. */
export function StoreArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <path className="fb" d="M70 70 H250 L262 104 H58 Z" />
        <rect className="fp" x="80" y="104" width="160" height="96" />
        <rect className="fc" x="128" y="140" width="64" height="40" rx="6" />
      </g>
      <path className="ln" pathLength={1} style={i(0)} d="M70 70 H250 L262 104 H58 Z" />
      <path className="ln ln-thin" pathLength={1} style={i(1)} d="M100 70 L94 104 M130 70 L128 104 M160 70 V104 M190 70 L192 104 M220 70 L226 104" />
      <path className="ln" pathLength={1} style={i(2)} d="M80 104 V200 H240 V104" />
      <rect className="ln" pathLength={1} style={i(3)} x="128" y="140" width="64" height="40" rx="6" />
      <path className="ln" pathLength={1} style={i(4)} d="M118 186 H202" />
      <path className="ln ln-thin" pathLength={1} style={i(5)} d="M140 154 l8 8 l16 -16" />
    </Art>
  );
}

/** A helper you trust: two phones, one private link between them. */
export function HelperArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 240" className={className} label={label} delay={delay}>
      <g className="off">
        <rect className="fb" x="48" y="58" width="70" height="124" rx="14" />
        <rect className="fc" x="202" y="58" width="70" height="124" rx="14" />
      </g>
      <rect className="ln" pathLength={1} style={i(0)} x="48" y="58" width="70" height="124" rx="14" />
      <rect className="ln" pathLength={1} style={i(1)} x="202" y="58" width="70" height="124" rx="14" />
      <path className="ln ln-dash" d="M124 120 Q160 92 196 120" />
      <path className="ln" pathLength={1} style={i(2)} d="M160 102 c-8 -10 -22 -2 -14 10 l14 14 l14 -14 c8 -12 -6 -20 -14 -10 Z" />
      <path className="ln ln-thin" pathLength={1} style={i(3)} d="M72 168 h22 M226 168 h22" />
    </Art>
  );
}

/** Nothing here yet: a closed parcel waiting. */
export function EmptyArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 320 200" className={className} label={label} delay={delay}>
      <g className="off">
        <path className="fb" d="M100 80 H220 V170 H100 Z" />
        <rect className="fc" x="146" y="80" width="28" height="44" />
      </g>
      <path className="ln" pathLength={1} style={i(0)} d="M100 80 H220 V170 H100 Z" />
      <path className="ln" pathLength={1} style={i(1)} d="M100 80 L124 56 H244 L220 80 M220 170 L244 146 V56" />
      <path className="ln" pathLength={1} style={i(2)} d="M146 80 V124 H174 V80" />
      <path className="ln ln-dash" d="M40 182 H280" />
    </Art>
  );
}

/** Maya: headphones on, phone in hand. A portrait for her persona card. */
export function MayaArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 200 200" className={className} label={label} delay={delay}>
      <circle className="fb" cx="100" cy="100" r="92" />
      <g className="off">
        <path className="fa" d="M48 196 C52 156 72 140 100 140 C128 140 148 156 152 196 Z" />
        <path className="fc" d="M66 92 C64 60 80 44 100 44 C120 44 136 60 134 92 C126 78 112 70 100 70 C88 70 74 78 66 92 Z" />
      </g>
      {/* shoulders and sweater */}
      <path className="ln" pathLength={1} style={i(0)} d="M48 196 C52 156 72 140 100 140 C128 140 148 156 152 196" />
      <path className="ln ln-thin" pathLength={1} style={i(1)} d="M86 142 Q100 156 114 142" />
      {/* neck and face */}
      <path className="ln" pathLength={1} style={i(2)} d="M90 128 V140 M110 128 V140" />
      <path className="ln" pathLength={1} style={i(3)} d="M70 92 C70 116 82 132 100 132 C118 132 130 116 130 92" />
      {/* hair with a bun */}
      <path className="ln" pathLength={1} style={i(4)} d="M66 92 C64 60 80 44 100 44 C120 44 136 60 134 92 C126 78 112 70 100 70 C88 70 74 78 66 92 Z" />
      <circle className="ln" pathLength={1} style={i(5)} cx="100" cy="34" r="11" />
      {/* headphones */}
      <path className="ln" pathLength={1} style={i(6)} d="M60 98 C56 56 76 38 100 38 C124 38 144 56 140 98" />
      <rect className="ln" pathLength={1} style={i(7)} x="54" y="90" width="14" height="24" rx="6" />
      <rect className="ln" pathLength={1} style={i(8)} x="132" y="90" width="14" height="24" rx="6" />
      {/* a calm smile, eyes closed */}
      <path className="ln ln-thin" pathLength={1} style={i(9)} d="M86 100 q5 4 10 0 M104 100 q5 4 10 0" />
      <path className="ln ln-thin" pathLength={1} style={i(10)} d="M92 116 q8 6 16 0" />
      {/* sound, gently */}
      <path className="ln ln-thin wave" pathLength={1} style={i(11)} d="M158 86 q8 12 0 24" />
      <path className="ln ln-thin wave" pathLength={1} style={i(12)} d="M168 78 q14 20 0 40" />
    </Art>
  );
}

/** Raj: big glasses and a magnifier, for low vision. A portrait for his persona card. */
export function RajArt({ className, label, delay }: P) {
  return (
    <Art viewBox="0 0 200 200" className={className} label={label} delay={delay}>
      <circle className="fc" cx="100" cy="100" r="92" />
      <g className="off">
        <path className="fa" d="M48 196 C52 156 72 140 100 140 C128 140 148 156 152 196 Z" />
        <path className="fp" d="M68 84 C68 56 84 46 100 46 C116 46 132 56 132 84 C122 74 110 70 100 70 C90 70 78 74 68 84 Z" />
      </g>
      <path className="ln" pathLength={1} style={i(0)} d="M48 196 C52 156 72 140 100 140 C128 140 148 156 152 196" />
      <path className="ln ln-thin" pathLength={1} style={i(1)} d="M88 142 L100 154 L112 142" />
      <path className="ln" pathLength={1} style={i(2)} d="M90 128 V140 M110 128 V140" />
      <path className="ln" pathLength={1} style={i(3)} d="M70 88 C70 114 82 132 100 132 C118 132 130 114 130 88" />
      {/* short hair */}
      <path className="ln" pathLength={1} style={i(4)} d="M68 84 C68 56 84 46 100 46 C116 46 132 56 132 84 C122 74 110 70 100 70 C90 70 78 74 68 84 Z" />
      {/* big round glasses */}
      <circle className="ln" pathLength={1} style={i(5)} cx="87" cy="98" r="12" />
      <circle className="ln" pathLength={1} style={i(6)} cx="113" cy="98" r="12" />
      <path className="ln ln-thin" pathLength={1} style={i(7)} d="M99 98 h2 M75 96 l-6 -2 M125 96 l6 -2" />
      <circle className="fi pop" style={i(0)} cx="87" cy="99" r="2.5" />
      <circle className="fi pop" style={i(1)} cx="113" cy="99" r="2.5" />
      <path className="ln ln-thin" pathLength={1} style={i(8)} d="M92 118 q8 6 16 0" />
      {/* a hand magnifier */}
      <circle className="ln" pathLength={1} style={i(9)} cx="158" cy="148" r="16" />
      <path className="ln" pathLength={1} style={i(10)} d="M146 160 L132 176" />
    </Art>
  );
}
