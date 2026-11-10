import type { JourneyStep } from './journey';

/* Shared copy for the public pages: home, how it works, agents, PayPal and proof. */

export const NUMBERS = [
  {
    figure: '95.9%',
    text: 'of the top million home pages have accessibility failures a machine can find. Shop home pages average about 75 errors each.',
    source: 'WebAIM Million, 2026',
    href: 'https://webaim.org/projects/million/',
  },
  {
    figure: '49%',
    text: 'of disabled shoppers who needed to return something had problems doing it. One in seven could not use the retailer’s suggested return method.',
    source: 'Which? with RIDC, 844 disabled consumers',
    href: 'https://www.which.co.uk/policy-and-insight/article/retailers-and-returns-services-potentially-breaking-law-on-returns-for-disabled-consumers-which-finds-ac8dn1v6s5K7',
  },
  {
    figure: '27%',
    text: 'of people who use assistive technology abandon a purchase every month because of accessibility barriers.',
    source: 'Fable, the state of online shopping',
    href: 'https://makeitfable.com/article/insights-the-state-of-online-shopping-for-people-with-disabilities/',
  },
];

export const STEPS: JourneyStep[] = [
  {
    key: 'ask',
    label: 'Ask',
    title: 'Say what you need.',
    body: 'Talk or type. Your agent searches real stores, asks one question when it has to, and gives you three options at most, each with the facts that matter: colour, size, price and returns. When a listing does not say, it tells you so.',
    said: '“A warm navy sweater, medium, nothing scratchy, under sixty dollars.”',
  },
  {
    key: 'readback',
    label: 'Hear it back',
    title: 'Hear exactly what you will pay.',
    body: 'Before any money moves, a fixed template, not the AI, reads back the item, colour, size, seller and total. You confirm with your voice and one more press. Saying yes twice can never charge you twice.',
    said: '“Harbor knit crew-neck, navy, size M, from Demo Store. Total $36.72. Say confirm to pay.”',
  },
  {
    key: 'hold',
    label: 'PayPal holds it',
    title: 'The money waits for you.',
    body: 'PayPal holds the payment instead of taking it. The store is paid only after your check passes. If the store does not answer in time, the hold is released by itself.',
    said: '“PayPal is holding $36.72. Demo Store is paid after you check the parcel.”',
  },
  {
    key: 'check',
    label: 'Check it',
    title: 'Check it with your camera.',
    body: 'When the parcel arrives, your phone talks you into frame and takes the photos for you: the item, the size tag, any damage. You hear a plain answer and how sure it is. Not sure? Send a private link to someone you trust.',
    said: '“The tag reads L. You ordered M. I’m fairly sure.”',
  },
  {
    key: 'back',
    label: 'Money back',
    title: 'Get your money back.',
    body: 'Say it is wrong. Your agent signs an evidence pack, talks to the store’s agent and reads you their offer. Accept with two presses, and PayPal releases the hold or refunds you.',
    said: '“Demo Store offers a replacement in size M. Press accept twice to take it.”',
  },
];

export const AGENT = [
  {
    title: 'Shops like a friend who knows',
    body: 'It searches several ways, reads the details, compares and explains the trade-offs in plain words, and asks you when it is unsure.',
  },
  {
    title: 'Remembers your sizes and likes',
    body: 'Only when you say so. “I’m a medium in sweaters, nothing with wool.” See, change or forget any of it in Settings.',
  },
  {
    title: 'Answers your money questions',
    body: '“What is on hold?” “When does it expire?” “Did I get my refund?” Answered from your real orders and PayPal’s states, never a guess.',
  },
  {
    title: 'Talks to the store’s agent',
    body: 'The store’s own agent reads the signed evidence and proposes a fix within the store’s rules. You hear it and decide.',
  },
  {
    title: 'Shows every step it took',
    body: 'A plain timeline on every order: what your agent did, with which tool, and when. Nothing happens out of sight.',
  },
  {
    title: 'Never pays on its own',
    body: 'Money moves only after the spoken readback, your yes and a second press, through a safety check that blocks repeats and changed totals.',
  },
];

export const PAYPAL = [
  ['Orders v2', 'authorize at checkout, so the money is held, not taken'],
  ['Payments v2', 'capture after the check, void a wrong order, refund, reauthorize'],
  ['Webhooks', 'every PayPal update verified by signature and read aloud'],
  ['Package tracking', 'the carrier and tracking number added to the PayPal order'],
  ['Disputes', 'a case with the signed evidence pack when a store does not answer'],
  ['Vault', 'a returning buyer pays without retyping a card'],
];

/** "0 of 266" never breaks between its words; anything after it, like "(82.7%)", still can. */
export const keepCountTogether = (value: string) => value.replace(/(\d) of (\d)/g, '$1 of $2');
