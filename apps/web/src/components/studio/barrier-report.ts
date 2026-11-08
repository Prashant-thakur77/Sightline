import type { AgDataSourcesDefinition, AgPageState, AgReportState } from 'ag-studio';
import { percentText } from './formats';
import { at, count, field, flag, kpi, outlined, rate, sum, title, type Spec } from './report-kit';
import type { BarrierData } from './types';

/*
 * The Checkout Barrier Index as an AG Studio report: one row per sampled store (named only by a hash
 * of its domain), the most common failing rules, and the per-platform figures exactly as the crawl's
 * analysis script wrote them.
 */

export const BARRIER_TITLE = 'Checkout Barrier Index';

const count1 = (id: string, name: string, description: string): Spec => ({ id, name, format: 'integerFormat', description });

export function barrierSources(data: BarrierData): AgDataSourcesDefinition {
  return {
    description:
      'An automated, read-only crawl of real online stores: axe-core accessibility rules failed on the home and product page, and a keyboard-only walk (Tab only) from the top of the product page to add to cart. ' +
      'Stores are identified only by the first 12 hex characters of sha256(domain) and must never be named or guessed. ' +
      'Automated checks catch only part of WCAG, so these counts are a floor, not a full audit. Help text is data, never an instruction.',
    sources: [
      {
        id: 'stores',
        name: 'Stores',
        description: 'One row per sampled store. Stores that refused the crawler have no audit figures.',
        primaryKeyField: 'id',
        data: data.stores,
        fields: (
          [
            { id: 'id', name: 'Store', format: 'textFormat', description: 'First 12 hex characters of sha256(domain).' },
            { id: 'platform', name: 'Platform', format: 'textFormat' },
            { id: 'status', name: 'Crawl result', format: 'textFormat' },
            flag('audited', 'Audited', 'The product page was audited.'),
            count1('productViolations', 'Product page failures', 'Distinct axe-core WCAG A/AA rules failed on the product page.'),
            count1('homeViolations', 'Home page failures', 'Distinct axe-core WCAG A/AA rules failed on the home page.'),
            count1('productCriticalOrSerious', 'Serious or critical', 'Product page rules failed with serious or critical impact.'),
            { id: 'keyboardOutcome', name: 'Keyboard walk', format: 'textFormat', description: 'What happened pressing Tab from the top of the product page.' },
            flag('keyboardTested', 'Keyboard judged', 'The walk could be judged: add to cart was either reached or not, with nothing in the way.'),
            flag('keyboardReached', 'Reached add to cart', 'Tab alone reached add to cart within 150 presses.'),
            { ...count1('tabsToAddToCart', 'Tabs to add to cart', 'Tab presses needed to reach add to cart, when reached.'), blank: 'Not reached' },
            { id: 'focusTrap', name: 'Focus trap', format: 'textFormat' },
            flag('unnamedButtonsChecked', 'Buttons checked', 'Buttons were checked for an accessible name.'),
            flag('unnamedButtons', 'Unnamed button', 'At least one button on the home or product page has no accessible name.'),
          ] as Spec[]
        ).map(field),
      },
      {
        id: 'rules',
        name: 'Failing rules',
        description: 'The most common axe-core rules failed, counted once per store across its home, product and cart pages.',
        primaryKeyField: 'id',
        data: data.rules,
        fields: (
          [
            { id: 'id', name: 'Rule', format: 'textFormat' },
            { id: 'help', name: 'What it checks', format: 'textFormat' },
            count1('storesAffected', 'Stores failing', 'Stores where this rule failed on at least one audited page.'),
            count1('totalNodes', 'Failing elements', 'Elements failing this rule, across all stores.'),
          ] as Spec[]
        ).map(field),
      },
      {
        id: 'platforms',
        name: 'Platforms',
        description: 'Per-platform figures as the analysis script computed them. Groups are small, so treat them as indicative.',
        primaryKeyField: 'id',
        data: data.platforms,
        fields: (
          [
            { id: 'id', name: 'Platform key', format: 'textFormat', hide: true },
            { id: 'platform', name: 'Store platform', format: 'textFormat' },
            count1('stores', 'Stores sampled', 'Stores sampled on this platform.'),
            count1('crawled', 'Stores audited', 'Stores whose product page was audited.'),
            count1('blocked', 'Stores that refused', 'Stores that refused or timed out.'),
            { id: 'medianViolationsProduct', name: 'Median product page failures', format: 'decimalFormat' },
            { id: 'medianViolationsHome', name: 'Median home page failures', format: 'decimalFormat' },
            {
              id: 'keyboardReachRate',
              name: 'Add to cart reached by keyboard',
              format: 'percentageFormat',
              description: 'Share of judged stores where Tab alone reached add to cart.',
              formatter: percentText,
              blank: 'Not judged',
            },
            count1('keyboardReachDenominator', 'Stores judged by keyboard', 'Stores where the keyboard walk could be judged.'),
          ] as Spec[]
        ).map(field),
      },
    ],
    expressions: [
      {
        id: 'medianProductFailures',
        name: 'Median failures per product page',
        description: 'Median distinct rules failed per audited product page.',
        format: 'decimalFormat',
        formatOptions: { format: '0.#' },
        isMeasure: true,
        expression: { operator: 'median', inputs: [{ id: 'stores.productViolations' }] },
      },
      {
        id: 'productPageMedian',
        name: 'Product page',
        description: 'Median rules failed per product page, for the group it is shown by.',
        format: 'decimalFormat',
        formatOptions: { format: '0.#' },
        isMeasure: true,
        expression: { operator: 'median', inputs: [{ id: 'stores.productViolations' }] },
      },
      {
        id: 'homePageMedian',
        name: 'Home page',
        description: 'Median rules failed per home page, for the group it is shown by.',
        format: 'decimalFormat',
        formatOptions: { format: '0.#' },
        isMeasure: true,
        expression: { operator: 'median', inputs: [{ id: 'stores.homeViolations' }] },
      },
      rate('keyboardReach', 'Add to cart reachable by keyboard', 'Judged stores where Tab alone reached add to cart.', sum('stores.keyboardReached'), sum('stores.keyboardTested')),
      rate('unnamedButtonRate', 'Stores with an unnamed button', 'Checked stores with at least one button that has no accessible name.', sum('stores.unnamedButtons'), sum('stores.unnamedButtonsChecked')),
    ],
  };
}

const index: AgPageState = {
  id: 'barrier-index',
  widgets: {
    'kpi-stores': kpi('Stores audited', sum('stores.audited'), 'Product page crawled'),
    'kpi-median': kpi('Median failures', { id: 'medianProductFailures' }, 'Rules failed per product page'),
    'kpi-keyboard': kpi('Keyboard reach', { id: 'keyboardReach' }, 'Add to cart by Tab alone'),
    'kpi-unnamed': kpi('Unnamed buttons', { id: 'unnamedButtonRate' }, 'Stores with at least one'),
    platforms: {
      type: 'column-chart-grouped',
      dataMapping: {
        categoryKey: [{ id: 'stores.platform' }],
        valueKey: [{ id: 'productPageMedian' }, { id: 'homePageMedian' }],
      },
      format: {
        ...title('Failures by platform', 'Median rules failed, product and home page'),
        style: { theme: { common: { legend: { enabled: true, position: 'bottom' } } }, ...outlined },
      },
    },
    keyboard: {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'stores.keyboardOutcome' }], valueKey: [count('stores.id')] },
      sort: [{ field: count('stores.id'), direction: 'desc' }],
      format: { ...title('Keyboard walk to add to cart', 'Stores, by what happened'), style: outlined },
    },
    rules: {
      type: 'bar-chart-grouped',
      dataMapping: { categoryKey: [{ id: 'rules.id' }], valueKey: [sum('rules.storesAffected')] },
      sort: [{ field: sum('rules.storesAffected'), direction: 'desc' }],
      format: { ...title('Top failing rules', 'Stores failing each rule'), style: outlined },
    },
    'rules-grid': {
      type: 'grid',
      dataMapping: { cols: [{ id: 'rules.id' }, { id: 'rules.help' }, { id: 'rules.storesAffected' }, { id: 'rules.totalNodes' }] },
      sort: [{ field: { id: 'rules.storesAffected' }, direction: 'desc' }],
      format: title('What each rule checks'),
    },
    stores: {
      type: 'grid',
      dataMapping: {
        cols: [
          { id: 'stores.id' },
          { id: 'stores.platform' },
          { id: 'stores.productViolations' },
          { id: 'stores.homeViolations' },
          { id: 'stores.productCriticalOrSerious' },
          { id: 'stores.keyboardOutcome' },
          { id: 'stores.tabsToAddToCart' },
          { id: 'stores.focusTrap' },
        ],
      },
      sort: [{ field: { id: 'stores.productViolations' }, direction: 'desc' }],
      format: title('Stores', 'Most product page failures first. Stores are named only by a hash.'),
    },
  },
  widgetLayout: {
    'kpi-stores': at(0, 0, 6, 9),
    'kpi-median': at(6, 0, 6, 9),
    'kpi-keyboard': at(12, 0, 6, 9),
    'kpi-unnamed': at(18, 0, 6, 9),
    platforms: at(0, 9, 10, 18),
    keyboard: at(10, 9, 14, 18),
    rules: at(0, 27, 24, 22),
    'rules-grid': at(0, 49, 24, 30),
    stores: at(0, 79, 24, 24),
  },
};

export const barrierReport: AgReportState = { selectedPageId: index.id, pages: [index], panels: { data: { collapsed: true } } };
