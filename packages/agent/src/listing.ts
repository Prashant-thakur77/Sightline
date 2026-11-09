/**
 * Reading a store listing honestly before it is frozen into a snapshot: its colour from its own
 * words (never from a brand or a team name), whether it is fan or licensed team merchandise, and
 * which of its sizes the buyer asked for. Deterministic: lexicon matches only.
 */
import type { CatalogProduct, SizeOffer } from '@sightline/catalog';
import { COLOURS, findPhrases, sameSize } from './lexicon';
import { normaliseText, words } from './text';

/**
 * Phrases in which a colour word names something else: a brand, a team, an institution or a band.
 * "Old Navy" is not navy; "Navy Midshipmen" is a team; "Red Sox" is not red.
 */
export const COLOUR_TRAPS = [
  'old navy',
  'navy midshipmen',
  'naval academy',
  'u.s. navy',
  'us navy',
  'royal navy',
  'navy seal',
  'navy seals',
  'navy federal',
  'red sox',
  'white sox',
  'blue jays',
  'red wings',
  'blue jackets',
  'black hawks',
  'golden state',
  'golden knights',
  'green bay',
  'orange county',
  'red bull',
  'red devils',
  'blue devils',
  'crimson tide',
  'black friday',
  'white house',
  'black diamond',
  'blue bell',
  'green day',
  'pink floyd',
  'black sabbath',
  'deep purple',
  'white stripes',
  'black keys',
  'maroon 5',
];

/** The listing's own words with brand names and colour traps blanked out. */
function stripTraps(text: string, brand?: string): string {
  let t = normaliseText(text);
  const blank = (phrase: string) => {
    const p = normaliseText(phrase);
    if (p) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(p)}(?![\\p{L}\\p{N}])`, 'gu'), ' ~ ');
  };
  if (brand) blank(brand);
  for (const trap of COLOUR_TRAPS) blank(trap);
  return t;
}

/** Distinct colours named in a piece of text, after traps and the brand are removed. */
export function coloursNamed(text: string, brand?: string): string[] {
  const ws = words(stripTraps(text, brand));
  return [...new Set(findPhrases(ws, COLOURS).map((m) => m.canonical))];
}

/** The colour a listing gives, as a plain colour, and the store's own name for it when that differs. */
export interface ListingColour {
  /** A colour the buyer can picture and the camera check can compare: "navy", "heather grey". */
  colour?: string;
  /** The store's own words when they are a marketing name: "In The Navy", "Abalone". */
  listedAs?: string;
}

/**
 * A store's colour label as speech can use it. A plain colour stays ("Navy Blue" is "navy blue").
 * A marketing name with one colour in it becomes that colour, keeping the store's words to say
 * beside it ("In The Navy" is navy, listed as "In The Navy"). A name with no colour word in it
 * ("Abalone") is never spoken as a colour: only as the listing's own words.
 */
export function normaliseColourLabel(label: string, title = ''): ListingColour {
  const raw = label.replace(/\s+/g, ' ').trim();
  if (!raw) return {};
  const tidy = tidyColourLabel(raw, title);
  const lw = words(tidy);
  const found = findPhrases(lw, COLOURS);
  const canon = [...new Set(found.map((m) => m.canonical))];
  if (canon.length === 0) return { listedAs: raw };
  const covered = found.reduce((n, m) => n + (m.end - m.start), 0);
  // Every word is a colour word ("navy blue", "charcoal heather grey", "black and white" minus "and").
  const fillers = lw.filter((w) => !found.some((m) => lw.slice(m.start, m.end).includes(w)));
  if (covered === lw.length || fillers.every((w) => ['and', '&', '/', '-', 'with'].includes(w))) return { colour: tidy };
  if (canon.length === 1) return { colour: canon[0], listedAs: raw };
  return { colour: tidy };
}

/**
 * The listing's colour: its colour field when it has one (normalised, see normaliseColourLabel),
 * else a "Color: navy" key feature, else the one colour its title names (brand names and team
 * names ignored). Two colours in a title ("black and white") or none give nothing.
 */
export function listingColour(p: Pick<CatalogProduct, 'title' | 'brand' | 'keyFeatures' | 'attributes'>): ListingColour {
  if (p.attributes.colour) return normaliseColourLabel(p.attributes.colour, p.title);
  for (const f of p.keyFeatures ?? []) {
    const m = /^\s*colou?r\s*[:\-–]\s*(.+?)\s*$/i.exec(f);
    if (m && m[1]) return normaliseColourLabel(m[1], p.title);
  }
  const named = coloursNamed(p.title, p.brand);
  return named.length === 1 ? { colour: named[0] } : {};
}

/** The plain colour, when the listing gives one. */
export function inferListingColour(p: Pick<CatalogProduct, 'title' | 'brand' | 'keyFeatures' | 'attributes'>): string | undefined {
  return listingColour(p).colour;
}

/**
 * "Navy Standard Hoodie" (a colour label that repeats the title) is "navy". A label with words of
 * its own ("midnight navy", "heather grey") is kept as the store wrote it.
 */
export function tidyColourLabel(label: string, title: string): string {
  const lw = words(label);
  const colourWords = new Set(findPhrases(lw, COLOURS).flatMap((m) => lw.slice(m.start, m.end)));
  if (colourWords.size === 0) return label.toLowerCase();
  const titleWords = new Set(words(title));
  const extra = lw.filter((w) => !colourWords.has(w));
  if (extra.length > 0 && extra.every((w) => titleWords.has(w))) return lw.filter((w) => colourWords.has(w)).join(' ');
  return label.toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Fan and licensed team merchandise

const LEAGUES = /\b(?:NCAA|NFL|NBA|WNBA|MLB|NHL|MLS|NASCAR|UFC|WWE|FIFA)\b/;
const FAN_PHRASES = [
  'officially licensed',
  'licensed apparel',
  'fan gear',
  'fan apparel',
  'fan shop',
  'game day',
  'gameday',
  'collegiate',
  'naval academy',
  'military academy',
  'air force academy',
  'midshipmen',
  'tailgate',
  'team logo',
  'team apparel',
  'alumni',
];
/** Team names unlikely to mean anything else in a product title. */
const MASCOTS = [
  'Midshipmen', 'Wolverines', 'Buckeyes', 'Longhorns', 'Crimson Tide', 'Fighting Irish', 'Seminoles', 'Gators', 'Jayhawks', 'Tar Heels',
  'Blue Devils', 'Hokies', 'Sooners', 'Razorbacks', 'Hawkeyes', 'Nittany Lions', 'Cornhuskers', 'Gamecocks', 'Commodores', 'Yellow Jackets',
  'Black Knights', 'Packers', 'Steelers', 'Patriots', 'Seahawks', '49ers', 'Buccaneers', 'Lakers', 'Celtics', 'Knicks', '76ers', 'Raptors',
  'Pistons', 'Timberwolves', 'Trail Blazers', 'Mavericks', 'Yankees', 'Red Sox', 'Orioles', 'Blue Jays', 'White Sox', 'Astros', 'Mariners',
  'Phillies', 'Cubs', 'Brewers', 'Diamondbacks', 'Rockies', 'Dodgers', 'Padres', 'Red Wings', 'Sabres', 'Maple Leafs', 'Blue Jackets',
  'Flyers', 'Blackhawks', 'Oilers', 'Canucks', 'Golden Knights', 'Kraken',
];
/** Team places: a place followed by a capitalised team word is a team ("Michigan State Spartans"). */
const PLACES = [
  'Boston', 'New York', 'Los Angeles', 'Chicago', 'Dallas', 'Houston', 'Miami', 'Atlanta', 'Denver', 'Detroit', 'Philadelphia', 'Pittsburgh',
  'Cleveland', 'Cincinnati', 'Baltimore', 'Seattle', 'San Francisco', 'San Diego', 'Oakland', 'Las Vegas', 'Kansas City', 'St. Louis',
  'Minnesota', 'Milwaukee', 'Green Bay', 'Indianapolis', 'Jacksonville', 'Tampa Bay', 'New England', 'New Orleans', 'Arizona', 'Phoenix',
  'Sacramento', 'Portland', 'Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Edmonton', 'Winnipeg', 'Ottawa', 'Buffalo', 'Carolina',
  'Charlotte', 'Orlando', 'Brooklyn', 'Memphis', 'San Antonio', 'Golden State', 'Anaheim', 'Nashville', 'Columbus', 'Navy', 'Army',
  'Air Force', 'Michigan', 'Ohio State', 'Michigan State', 'Penn State', 'Alabama', 'Auburn', 'Clemson', 'Notre Dame', 'Oklahoma',
  'Nebraska', 'Wisconsin', 'Kentucky', 'Duke', 'North Carolina', 'Virginia Tech', 'Texas A&M', 'Oregon', 'UCLA', 'USC', 'LSU',
];
const TEAM_WORDS = [
  'Bears', 'Lions', 'Giants', 'Jets', 'Eagles', 'Rams', 'Saints', 'Chiefs', 'Raiders', 'Chargers', 'Broncos', 'Bengals', 'Browns', 'Ravens',
  'Texans', 'Colts', 'Jaguars', 'Titans', 'Vikings', 'Falcons', 'Panthers', 'Cardinals', 'Commanders', 'Dolphins', 'Bills', 'Cowboys',
  'Bulls', 'Heat', 'Magic', 'Hawks', 'Hornets', 'Nets', 'Suns', 'Kings', 'Clippers', 'Warriors', 'Jazz', 'Thunder', 'Nuggets', 'Spurs',
  'Rockets', 'Grizzlies', 'Pelicans', 'Wizards', 'Pacers', 'Bucks', 'Cavaliers', 'Rangers', 'Mets', 'Braves', 'Marlins', 'Nationals',
  'Reds', 'Pirates', 'Twins', 'Royals', 'Tigers', 'Angels', 'Athletics', 'Guardians', 'Rays', 'Bruins', 'Canadiens', 'Senators',
  'Lightning', 'Hurricanes', 'Devils', 'Islanders', 'Penguins', 'Capitals', 'Avalanche', 'Stars', 'Wild', 'Predators', 'Blues', 'Ducks',
  'Flames', 'Sharks', 'Spartans', 'Wildcats', 'Bulldogs', 'Huskies', 'Ducks', 'Trojans', 'Volunteers', 'Aggies', 'Badgers', 'Cougars',
  'Mountaineers', 'Rebels', 'Hurricanes', 'Cyclones', 'Terrapins', 'Hoosiers', 'Boilermakers', 'Fighting Illini', 'Gophers', 'Wolfpack',
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MASCOT_RE = new RegExp(`\\b(?:${MASCOTS.map(escape).join('|')})\\b`);
const PLACE_TEAM_RE = new RegExp(`\\b(?:${PLACES.map(escape).join('|')})\\s+(?:${TEAM_WORDS.map(escape).join('|')})\\b`);
const FAN_RE = new RegExp(`\\b(?:${FAN_PHRASES.map(escape).join('|')})\\b`, 'i');
const UNIVERSITY_RE = /\b(?:University|College)\b/;

export interface ListingText {
  title: string;
  brand?: string;
  description?: string;
  category?: string;
}

/**
 * True for fan or licensed team merchandise: a league name, a team name ("Navy Midshipmen",
 * "Michigan Wolverines", "Boston Red Sox"), a university, or "officially licensed". Title case
 * matters: "navy" in a sentence is a colour, "Navy Midshipmen" is a team.
 */
export function isFanMerchandise(p: ListingText): boolean {
  const title = p.title;
  const text = `${title} ${p.brand ?? ''} ${p.description ?? ''}`;
  if (LEAGUES.test(text) || FAN_RE.test(text)) return true;
  if (MASCOT_RE.test(title) || PLACE_TEAM_RE.test(title)) return true;
  if (UNIVERSITY_RE.test(title)) return true;
  return /\bfan\b/i.test(p.category ?? '');
}

/** The buyer asked for team or fan gear, so it is not left out. */
export function wantsTeamGear(text: string): boolean {
  const t = ` ${normaliseText(text)} `;
  if (/\b(?:team|teams|fan|fans|jersey|jerseys|college|university|ncaa|nfl|nba|mlb|nhl|mls|licensed|game day|gameday|midshipmen|naval academy)\b/.test(t))
    return true;
  const titled = text.replace(/\b\w/g, (c) => c.toUpperCase());
  return MASCOT_RE.test(titled) || PLACE_TEAM_RE.test(titled);
}

// ---------------------------------------------------------------------------------------------
// Sizes

/**
 * How a listing answers the size the buyer asked for:
 * - in_stock / sold_out: it offers the size and the store says whether it has it;
 * - offered: it offers the size, and the store doesn't say whether it is in stock;
 * - other_listing: the store sells that size as its own listing (bought from there);
 * - listed: a one-size listing whose size is the one asked for;
 * - not_offered: it offers other sizes only, or it is another size;
 * - unknown: the listing gives no sizes, so the size can't be confirmed;
 * - not_asked: the buyer didn't ask for a size.
 */
export type SizeFit = 'in_stock' | 'sold_out' | 'offered' | 'other_listing' | 'listed' | 'not_offered' | 'unknown' | 'not_asked';

export interface SizeChoice {
  fit: SizeFit;
  /** The listing's own label for the size ("M", "S/M"). */
  label?: string;
  /** The listing to freeze for that size, when the store sells it as its own listing. */
  productId?: string;
  /** Every size the listing offers, by its labels. */
  offered: string[];
}

/** A label such as "S/M" offers both S and M. */
function offerMatches(label: string, wanted: string): boolean {
  if (sameSize(label, wanted)) return true;
  const parts = label.split(/\s*\/\s*/);
  return parts.length > 1 && parts.some((p) => sameSize(p, wanted));
}

export function chooseSize(p: Pick<CatalogProduct, 'sizes' | 'attributes'>, wanted: string | undefined): SizeChoice {
  const offered = (p.sizes ?? []).map((s) => s.label);
  if (!wanted) return { fit: 'not_asked', offered };
  const sizes: SizeOffer[] = p.sizes ?? [];
  if (sizes.length > 0) {
    const hit = sizes.find((s) => s.label && offerMatches(s.label, wanted));
    if (!hit) return { fit: 'not_offered', offered };
    if (hit.productId) return { fit: 'other_listing', label: hit.label, productId: hit.productId, offered };
    if (hit.available === false) return { fit: 'sold_out', label: hit.label, offered };
    return { fit: hit.available === true ? 'in_stock' : 'offered', label: hit.label, offered };
  }
  if (p.attributes.size) return sameSize(p.attributes.size, wanted) || offerMatches(p.attributes.size, wanted) ? { fit: 'listed', label: p.attributes.size, offered } : { fit: 'not_offered', offered };
  return { fit: 'unknown', offered };
}

/**
 * The product as it will be frozen for this buyer: its colour from its own words when the colour
 * field is empty, and the asked-for size chosen when the listing offers it. A listing that offers
 * several sizes and none was asked for carries no size: the buyer chooses one before buying.
 */
export function interpretListing(p: CatalogProduct, want: { size?: string } = {}): { product: CatalogProduct; size: SizeChoice } {
  const size = chooseSize(p, want.size);
  const { colour, listedAs } = listingColour(p);
  const attributes: CatalogProduct['attributes'] = { ...p.attributes };
  // A marketing name is never the colour: the colour is plain, the store's words are kept beside it.
  if (colour) attributes.colour = colour;
  else delete attributes.colour;
  if (listedAs) attributes.colourName = listedAs;
  const selected = { ...p.selected };
  if (size.label && ['in_stock', 'offered', 'sold_out', 'listed'].includes(size.fit)) {
    attributes.size = size.label;
    selected.Size = size.label;
  } else if (size.offered.length > 1) {
    delete attributes.size;
    delete selected.Size;
  }
  if (size.offered.length > 1) attributes.sizes = size.offered.join(', ');
  return { product: { ...p, attributes, selected }, size };
}
