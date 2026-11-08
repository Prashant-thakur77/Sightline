/**
 * English copy bank. Every user-facing sentence the agent speaks lives here.
 *
 * Rules: short sentences; say what happens next and how to undo it; never blame the user; no
 * "oops"; confidence in words (sure, fairly sure, not sure), never percentages; nothing that
 * depends on seeing the screen; money always with its currency; at most three options at once.
 */
import { PRODUCT_NAME, formatMoney, formatMoneyShort, type Confidence, type Money, type ReturnPolicy } from '@sightline/core';

/** Short money for conversation: "$34", "$36.72". */
export const m = (x: Money): string => formatMoneyShort(x);
/** Full money for the readback and receipts: "$34.00". */
export const mFull = (x: Money): string => formatMoney(x);

export const LISTING_DOESNT_SAY = "the listing doesn't say";

export const CONFIDENCE_WORDS: Record<Confidence, string> = {
  sure: 'sure',
  fairly_sure: 'fairly sure',
  not_sure: 'not sure',
};

export function confidenceSentence(c: Confidence): string {
  return `I'm ${CONFIDENCE_WORDS[c]} about that.`;
}

/** Return policy as a phrase, never guessed: unknown parts are said to be unknown. */
export function returnsPhrase(policy: ReturnPolicy | null | undefined): string {
  if (!policy || (policy.windowDays === undefined && policy.free === undefined)) {
    return policy?.text ? "Returns: the listing doesn't give a clear policy." : `Returns: ${LISTING_DOESNT_SAY}.`;
  }
  const days = policy.windowDays;
  const window = days === undefined ? undefined : `${days} ${days === 1 ? 'day' : 'days'}`;
  if (window !== undefined) {
    if (policy.free === true) return `Free returns within ${window}.`;
    if (policy.free === false) return `Returns within ${window}. Return shipping is not free.`;
    return `Returns within ${window}. The listing doesn't say if they're free.`;
  }
  if (policy.free === true) return "Free returns. The listing doesn't say for how long.";
  return "Return shipping is not free. The listing doesn't say how long you have.";
}

/** Compact form for option lists: "free returns for 30 days". */
export function returnsShort(policy: ReturnPolicy | null | undefined): string {
  if (!policy || (policy.windowDays === undefined && policy.free === undefined)) return 'return policy not given';
  const days = policy.windowDays;
  const window = days === undefined ? undefined : `${days} ${days === 1 ? 'day' : 'days'}`;
  if (window !== undefined) {
    if (policy.free === true) return `free returns for ${window}`;
    if (policy.free === false) return `returns for ${window}, not free`;
    return `returns for ${window}`;
  }
  return policy.free ? 'free returns' : 'returns not free';
}

function capitaliseFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export const en = {
  general: {
    listening: 'Listening.',
    notHeard: "I didn't catch that. Hold space and try again, or type it.",
    thinking: 'One moment.',
    stopped: 'Stopped.',
    welcome: (): string => `Welcome to ${PRODUCT_NAME}. Hold space to talk, or type. Say 'help' any time.`,
    intro: (): string =>
      `I'm ${PRODUCT_NAME}. I can find things, read back exactly what you're buying, and check your parcel when it arrives.`,
    nothingToRepeat: "There's nothing to repeat yet. Say what you're looking for.",
    notNow: "That isn't available right now. Nothing has changed. Say 'help' to hear what you can do.",
  },

  help: {
    main: "Here are three things you can say: 'find me' and what you need, a number to choose, or 'tell me more'. Say 'more help' for others.",
    more: "You can also say 'compare', 'where's my order', or 'this is wrong'. Say 'repeat' to hear that again.",
    readback: "To pay, say 'confirm purchase'. To change something, say what to change. To stop, say 'cancel'. Nothing is paid until you confirm.",
    offer: "Say 'accept' to accept the offer, or 'decline' to say no. Nothing changes until you choose.",
  },

  readback: {
    intro: "Here's what you're buying.",
    title: (t: string): string => `${t}.`,
    lead: (ordinal: string, t: string): string => `${ordinal}, ${t}.`,
    ordinals: ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'] as readonly string[],
    itemN: (n: number): string => `Item ${n}`,
    attribute: (label: string, value: string): string => `${label}: ${value}.`,
    quantity: (word: string): string => `Quantity: ${word}.`,
    quantityEach: (word: string, each: Money): string => `Quantity: ${word}, ${mFull(each)} each.`,
    soldBy: (seller: string): string => `Sold by ${seller}.`,
    moneyBrief: (total: Money, payment: string): string => `Total ${mFull(total)} with shipping and tax, paid with ${payment}.`,
    money: (itemLabel: string, items: Money, shipping: Money, tax: Money, total: Money, payment: string): string =>
      `${itemLabel} ${mFull(items)}, shipping ${shipping.cents === 0 ? 'free' : mFull(shipping)}, tax ${mFull(tax)}, total ${mFull(total)}, paid with ${payment}.`,
    today: (date: string): string => `today, ${date}`,
    tomorrow: (date: string): string => `tomorrow, ${date}`,
    fallbackTitle: 'An item',
    fallbackSeller: 'the seller',
    fallbackPayment: 'your PayPal',
    labels: {
      item: 'Item',
      brand: 'Brand',
      colour: 'Colour',
      size: 'Size',
      material: 'Material',
      fit: 'Fit',
      neckline: 'Neckline',
      pattern: 'Pattern',
      care: 'Care',
      quantity: 'Quantity',
      unitPrice: 'Price each',
      lineTotal: 'Line total',
      seller: 'Seller',
      returns: 'Returns',
      items: 'Items',
      itemSingular: 'Item',
      shipping: 'Shipping',
      tax: 'Tax',
      total: 'Total',
      paymentSource: 'Paid with',
      delivery: 'Delivery',
      free: 'Free',
      notGivenYet: 'Not given yet',
    },
    itemCount: (wordCount: string): string => `${wordCount} items.`,
    deliveryBy: (date: string): string => `Arrives by ${date}.`,
    deliveryUnknown: "The seller hasn't given a delivery date.",
    closingStandard: "To pay, say 'confirm purchase'. To change something, say what to change.",
    closingBrief: "Say 'confirm purchase' to pay, or say what to change.",
    closingDetailed:
      "To pay, say 'confirm purchase' or use the Confirm button. To change something, say what to change. To stop without paying, say 'cancel'.",
    missing: LISTING_DOESNT_SAY,
    invalidated: "Something changed since I read that to you, so I haven't paid. Here's the new version.",
  },

  confirm: {
    pressAgain: (total: Money): string => `Press confirm again to pay ${mFull(total)}.`,
    sayOrPressAgain: (total: Money): string =>
      `I couldn't double-check that. Press confirm again to pay ${mFull(total)}, or say 'confirm purchase'.`,
    held: "Okay, I'll wait. Nothing is paid. Say 'confirm purchase' when you're ready, or 'cancel' to stop.",
    cancelled: "Okay, I won't pay. Your cart is still here. Say 'buy it' when you're ready.",
    change: 'Okay, nothing is paid. Tell me what to change.',
    notSure: "I want to be sure before I pay. To pay, say 'confirm purchase'. To stop, say 'cancel'.",
    needPhrase: "To pay, say 'confirm purchase', or press the Confirm button. Nothing is paid yet.",
    classifierDown: (total: Money): string =>
      `I couldn't double-check that. Say 'confirm purchase' again, or press Confirm twice to pay ${mFull(total)}.`,
    otherLanguage: "For now I can only take payment confirmations in English. Say 'confirm purchase' to pay, or 'cancel' to stop.",
    question: "Nothing is paid yet. If you want to pay, say 'confirm purchase'. If not, say 'cancel'.",
    conditional: "I can't pay on a condition. Tell me what to check first, or say 'confirm purchase' to pay now.",
    confirmed: 'Confirmed. Paying now.',
    alreadyConfirmed: 'That purchase is already confirmed.',
    closed: "That readback is closed. Say 'buy it' to start again.",
    pressLapsed: (total: Money): string => `To pay ${mFull(total)}, press Confirm twice, or say 'confirm purchase'.`,
    offerAccepted: 'Accepted. I am telling PayPal now.',
  },

  payment: {
    paid: (total: Money, merchant: string): string =>
      `Paid. ${mFull(total)} to ${merchant}. Your receipt is saved. I'll tell you when it ships.`,
    authorised: (total: Money, merchant: string): string =>
      `${mFull(total)} is on hold for ${merchant}. You only pay once the check matches. I'll tell you when it ships.`,
    failed: "The payment didn't go through, and nothing was charged. Want me to try again?",
  },

  gate: {
    priceChanged: (from: Money, to: Money): string =>
      `The price changed from ${m(from)} to ${m(to)} since I read it to you. I haven't paid. Here's the new total.`,
    overOrderLimit: (limit: Money): string =>
      `That's over your ${m(limit)} limit for one order. You can raise the limit in settings, or pick something else.`,
    overDailyLimit: (limit: Money): string =>
      `That would go over your ${m(limit)} limit for today. Nothing was charged. You can raise it in settings, or try tomorrow.`,
    duplicate: "You already bought this a minute ago, so I didn't charge you again.",
    payeeNotAllowed: "I can't pay this seller safely, so I stopped. Nothing was charged. Want me to look for it from another store?",
    readbackChanged: "Something changed since I read that to you, so I haven't paid. I'll read it again.",
    notConfirmed: "I haven't paid because I didn't get both confirmations. Say 'confirm purchase' to try again.",
    rateLimited: "That's a lot of orders in a short time, so I've paused payments. Nothing was charged. Try again in a little while.",
    staleListing: "The listing may have changed, so I'm checking it again before paying. Nothing was charged.",
    sandboxOnly: "Payments are switched off here. Nothing was charged.",
  },

  search: {
    foundCount: (wordCount: string): string => `I found ${wordCount}.`,
    moreCount: (wordCount: string): string => `Here ${wordCount === 'one' ? 'is one' : `are ${wordCount}`} more.`,
    option: (word: string, parts: string[]): string => `${word}: ${parts.join(', ')}.`,
    colourNotGiven: 'colour not given',
    sizeNotGiven: 'size not given',
    sizeInStock: (size: string): string => `size ${size} in stock`,
    size: (size: string): string => `size ${size}`,
    rated: (avg: number, count: number): string => `rated ${avg} from ${count} ${count === 1 ? 'review' : 'reviews'}`,
    optionsPromptNoMore: "Say a number for details, or 'compare' to compare.",
    optionsPrompt1NoMore: "Say 'tell me more' for details.",
    describe: {
      anything: 'anything',
      inSize: (size: string): string => `in size ${size}`,
      under: (max: Money): string => `under ${m(max)}`,
      over: (min: Money): string => `over ${m(min)}`,
      withFreeReturns: 'with free returns',
    },
    suggestUpTo: (amount: Money): string => `up to ${m(amount)}`,
    suggestAnyColour: 'any colour',
    suggestAnySize: 'any size',
    suggestAnyReturns: 'without the free returns filter',
    suggestDifferentWords: 'different words',
    optionsPrompt3: "Say a number for details, 'compare' to compare, or 'more' for other options.",
    optionsPrompt2: "Say a number for details, 'compare' to compare, or 'more' for other options.",
    optionsPrompt1: "Say 'tell me more' for details, or 'more' for other options.",
    noMore: "That's everything I found. Want me to search for something a little different?",
    noneFound: (what: string): string => `I couldn't find ${what}.`,
    noneFoundGeneric: "I couldn't find anything for that.",
    tryInstead: (suggestions: string[]): string => `Want me to try ${suggestions.join(', or ')}?`,
    closestOverBudget: (price: Money): string => `The closest one is ${m(price)}.`,
    whyIntro: (wordCount: string): string => `Here's why I picked ${wordCount === 'one' ? 'this one' : 'these'}.`,
  },

  why: {
    colourMatch: (colour: string): string => `${capitaliseFirst(colour)}, as you asked.`,
    colourMismatch: (listed: string, wanted: string): string => `It's listed as ${listed}, not ${wanted}.`,
    sizeInStock: (size: string): string => `Size ${size} is in stock.`,
    sizeListed: (size: string): string => `Size ${size} is listed.`,
    sizeMismatch: (listed: string, wanted: string): string => `The listed size is ${listed}, not ${wanted}.`,
    categoryMatch: (category: string): string => `It's a ${category}, as you asked.`,
    categoryMismatch: (category: string): string => `It may not be a ${category}.`,
    attributeMatch: (value: string): string => `${capitaliseFirst(value)}, as you asked.`,
    attributeMismatch: (value: string): string => `It may not be ${value}.`,
    underBudget: (price: Money, budget: Money): string => `${m(price)}, under your ${m(budget)} budget.`,
    otherCurrency: (currency: string): string => `It's priced in ${currency}, so I couldn't compare it with your budget.`,
    freeReturns: (days?: number): string => (days ? `Free returns for ${days} days.` : 'Free returns.'),
    returnsWindow: (days: number): string => `Returns accepted for ${days} days.`,
    returnsNotFree: 'Return shipping is not free.',
    noReturnPolicy: "The listing doesn't give a return policy.",
    rating: (avg: number, count: number): string => `Rated ${avg} out of 5 from ${count} ${count === 1 ? 'review' : 'reviews'}.`,
    verifiable: 'The listing gives colour, size and photos, so I can check it when it arrives.',
    verifiableNoSize: 'The listing gives colour and photos, so I can check it when it arrives.',
    notVerifiable: (missing: string): string => `The listing doesn't give ${missing}, so it can't be checked on arrival.`,
    avoidColour: (colour: string): string => `It's ${colour}, a colour you avoid.`,
    barrier: "This store's own checkout is hard to use with a screen reader. I'd pay through PayPal instead.",
    missingNames: { colour: 'its colour', size: 'its size', images: 'photos' } as Record<'colour' | 'size' | 'images', string>,
    excluded: {
      overBudget: (price: Money, budget: Money): string => `${m(price)} is over your ${m(budget)} budget.`,
      underMin: (price: Money, min: Money): string => `${m(price)} is under your ${m(min)} minimum.`,
      outOfStock: 'It is out of stock.',
      sizeSoldOut: (size: string): string => `Size ${size} is sold out.`,
      notFreeReturns: "Returns aren't free.",
    },
  },

  compare: {
    intro: (labels: string): string => `Comparing ${labels}.`,
    row: (label: string, values: string): string => `${label}: ${values}.`,
    valueIs: (who: string, value: string): string => `${who} is ${value}`,
    valueHas: (who: string, value: string): string => `${who} has ${value}`,
    valueMissing: (who: string): string => `for ${who} the listing doesn't say`,
    cheaperBy: (who: string, diff: Money): string => `${capitaliseFirst(who)} is cheaper by ${m(diff)}.`,
    samePrice: 'They cost the same.',
    cantFeel: (aspect: string): string => `I can't tell which is ${aspect} for sure. Here's what each listing says it's made of.`,
    labels: { price: 'Price', colour: 'Colour', size: 'Size', material: 'Material', returns: 'Returns', rating: 'Rating' },
    noRating: 'no ratings',
    ratingValue: (avg: number, count: number): string => `rated ${avg} out of 5 from ${count} ${count === 1 ? 'review' : 'reviews'}`,
    cheapest: (who: string, price: Money): string => `${capitaliseFirst(who)} is the cheapest, at ${m(price)}.`,
  },

  details: {
    listingDoesntSay: "The listing doesn't say.",
    intro: (title: string, seller: string): string => `${title}, sold by ${seller}.`,
    sizingNoNotes: "The listing doesn't give fit notes. Want me to check what reviews say about sizing?",
    shippingUnknown: "The listing doesn't say how long shipping takes. I'll give you a date in the readback before you pay.",
    sizeChartMissing: "The listing doesn't include a size chart.",
    material: (v: string): string => `It's made of ${v}.`,
    materialMissing: "The listing doesn't say what it's made of.",
    care: (v: string): string => `Care: ${v}.`,
    careMissing: "The listing doesn't give care instructions.",
    fit: (v: string): string => `Fit: ${v}.`,
    fitMissing: "The listing doesn't describe the fit.",
    colour: (v: string): string => `The listing calls the colour ${v}.`,
    colourMissing: "The listing doesn't say what colour it is.",
    size: (v: string): string => `Size: ${v}.`,
    sizeMissing: "The listing doesn't give a size.",
    seller: (v: string): string => `Sold by ${v}.`,
    price: (v: Money): string => `It costs ${m(v)}.`,
    rating: (avg: number, count: number): string =>
      `Rated ${avg} out of 5 from ${count} ${count === 1 ? 'review' : 'reviews'}.`,
    ratingMissing: 'There are no ratings yet.',
    reviewsNotRead: "I haven't read the reviews for that yet. Want me to?",
  },

  check: {
    sizeDisagree: (observed: string, expected: string): string => `The size tag reads ${observed}, you ordered ${expected}.`,
    colourDisagree: (observed: string, expected: string): string => `The colour looks ${observed}, not ${expected}.`,
    identityDisagree: (noun: string, observed?: string): string =>
      observed ? `It looks like ${observed}, not the ${noun} you ordered.` : `It looks like a different ${noun} from the one you ordered.`,
    damage: (observed?: string): string => (observed ? `I can see damage: ${observed}.` : 'I can see damage.'),
    qualityDisagree: (observed?: string): string =>
      observed ? `It doesn't look like the listing: ${observed}.` : "It doesn't look like the quality in the listing.",
    unknownModule: (what: string): string => `I couldn't check the ${what}.`,
    unsureBetween: (expected: string, observed: string): string => `I'm not sure if this is ${expected} or ${observed}.`,
    unsureAbout: (what: string): string => `I'm not sure about the ${what}.`,
    matchPartsLead: 'This matches: ',
    matchSize: (size: string): string => `size ${size}`,
    matchSame: (noun: string): string => `the same ${noun}`,
    matchGeneric: 'This matches what you ordered.',
    moduleNames: { colour: 'colour', size: 'size', identity: 'item', damage: 'condition', quality: 'quality' } as Record<string, string>,
    defaultNoun: 'item',
    deliveredOffer: (merchant: string): string => `Your parcel from ${merchant} was delivered. Want to check it now?`,
    matchHeadline: 'This matches',
    mismatchHeadline: "This doesn't match.",
    unsureHeadline: "I'm not sure about this one.",
    enjoy: 'Enjoy it.',
    payAfterCheckCaptured: "I've told PayPal to complete the payment now.",
    payAfterCheckVoided: "I've told PayPal to cancel the payment, so you won't be charged.",
    offerMoneyBack: 'Want me to get your money back?',
    lessSureDim: 'but the light is dim so I\'m less sure',
    lessSure: "but I'm less sure about that",
    askHelper: (name: string): string => `I can ask ${name} to look`,
    tryDaylight: 'you can try again in daylight',
    tryAgainLater: 'Want to try again near a window?',
  },

  cases: {
    sent: (merchant: string, deadline: string): string =>
      `I sent your case to ${merchant} through PayPal. They have until ${deadline} to reply. I'll tell you when they do.`,
    noReply: (merchant: string): string => `${merchant} hasn't replied. Want me to ask PayPal to step in?`,
    escalated: "I asked PayPal to step in. I'll tell you when they decide.",
    acceptPrompt: "Say 'accept' to accept.",
    offerFullRefund: (merchant: string, amount: Money): string => `${merchant} offered a full refund of ${mFull(amount)}`,
    offerPartialRefund: (merchant: string, amount: Money): string => `${merchant} offered a partial refund of ${mFull(amount)}`,
    offerReplacement: (merchant: string, noun: string): string => `${merchant} offered to send a replacement ${noun}`,
    ifSendBack: (noun: string): string => ` if you send the ${noun} back.`,
    keepIt: (noun: string): string => `, and you keep the ${noun}.`,
    declinePrompt: "Say 'decline' to say no.",
    returnLabel: 'The return label is in your email.',
    refunded: (amount: Money): string =>
      `PayPal refunded ${mFull(amount)}. It should reach your PayPal balance within minutes.`,
    sellerWon: (merchant: string): string =>
      `PayPal decided in favour of ${merchant}. I'm sorry. Want me to read you their reasons?`,
    declined: (merchant: string): string => `Okay, I declined. I'll tell ${merchant}, and your case stays open.`,
    summaryConfirm: "Should I send it? Say 'send it' to send, or tell me what to change.",
  },

  grounding: {
    doesntSay: "The listing doesn't say.",
    fallback: "I'll stick to what the listing says.",
  },

  money: {
    olderPrompt: "Say 'more' to hear older ones.",
    nothingYet: 'No payments yet.',
    noOlder: "That's everything.",
    today: 'Today',
    yesterday: 'Yesterday',
    on: (day: string): string => `On ${day}`,
    paid: (when: string, merchant: string, amount: Money): string => `${when}, you paid ${merchant} ${mFull(amount)}.`,
    authorised: (when: string, merchant: string, amount: Money): string =>
      `${when}, ${mFull(amount)} was put on hold for ${merchant}. You pay only if the check matches.`,
    voided: (when: string, merchant: string, amount: Money): string =>
      `${when}, the ${mFull(amount)} hold for ${merchant} was cancelled. You weren't charged.`,
    refunded: (when: string, merchant: string, amount: Money): string => `${when}, PayPal refunded ${mFull(amount)} from ${merchant}.`,
    caseOpened: (when: string, merchant: string): string => `${when}, you opened a case with ${merchant}.`,
    deadline: (merchant: string, date: string): string => `Coming up: ${merchant} has until ${date} to reply to your case.`,
  },

  settings: {
    faster: "Okay, I'll talk faster. Say 'slower' to undo.",
    slower: "Okay, I'll talk slower. Say 'faster' to undo.",
    brief: "Okay, I'll keep it brief. Say 'more detail' to undo.",
    detailed: "Okay, I'll give more detail. Say 'be brief' to undo.",
    standard: "Okay, back to normal detail.",
    limitAsk: 'What should your limit for one order be?',
    limitSet: (limit: Money): string =>
      `Your limit for one order is now ${m(limit)}. Say 'change my spending limit' to change it again.`,
  },
} as const;

export type CopyBank = typeof en;
