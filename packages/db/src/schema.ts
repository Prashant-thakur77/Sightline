import {
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const created = () => ts('created_at').notNull().defaultNow();

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  locale: text('locale').notNull().default('en-US'),
  /** Demo personas (Maya, Raj) are seeded and can be entered without sign-up from /judge. */
  isDemo: boolean('is_demo').notNull().default(false),
  paypalPayerId: text('paypal_payer_id'),
  createdAt: created(),
});

export const passkeys = pgTable('passkeys', {
  credentialId: text('credential_id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  publicKey: bytea('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  transports: jsonb('transports').$type<string[]>(),
  createdAt: created(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  createdAt: created(),
});

export const magicLinks = pgTable('magic_links', {
  tokenHash: text('token_hash').primaryKey(),
  email: text('email').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: created(),
});

export const preferences = pgTable('preferences', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  verbosity: text('verbosity').notNull().default('standard'),
  voiceMode: text('voice_mode').notNull().default('screen-reader'),
  speechRate: integer('speech_rate_pct').notNull().default(100),
  sizes: jsonb('sizes').$type<Record<string, string>>().notNull().default({}),
  avoidColours: jsonb('avoid_colours').$type<string[]>().notNull().default([]),
  perOrderCapCents: integer('per_order_cap_cents').notNull().default(10000),
  dailyCapCents: integer('daily_cap_cents').notNull().default(25000),
  maxOrdersPerHour: integer('max_orders_per_hour').notNull().default(5),
  lowVision: jsonb('low_vision')
    .$type<{ enabled: boolean; textScale: number; highContrast: boolean }>()
    .notNull()
    .default({ enabled: false, textScale: 1, highContrast: false }),
  payAfterCheck: boolean('pay_after_check').notNull().default(true),
  onboardedAt: ts('onboarded_at'),
});

export const helpers = pgTable('helpers', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  contact: text('contact').notNull(),
  verifiedAt: ts('verified_at'),
  revokedAt: ts('revoked_at'),
  createdAt: created(),
});

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Agent working state: last options shown, active cart/readback, etc. */
  state: jsonb('state').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: created(),
  updatedAt: created(),
});

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    text: text('text').notNull(),
    segments: jsonb('segments').$type<unknown[]>(),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    createdAt: created(),
  },
  (t) => [index('messages_conv_idx').on(t.conversationId, t.createdAt)],
);

export const productSnapshots = pgTable('product_snapshots', {
  id: text('id').primaryKey(),
  productId: text('product_id').notNull(),
  variantId: text('variant_id').notNull(),
  source: text('source').notNull(),
  body: jsonb('body').notNull(),
  hash: text('hash').notNull(),
  archiveRef: text('archive_ref'),
  axeSummary: jsonb('axe_summary'),
  capturedAt: ts('captured_at').notNull(),
});

export const carts = pgTable(
  'carts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    body: jsonb('body').notNull(),
    hash: text('hash').notNull(),
    status: text('status').notNull().default('open'),
    createdAt: created(),
  },
  (t) => [index('carts_hash_idx').on(t.hash)],
);

export const readbacks = pgTable('readbacks', {
  id: text('id').primaryKey(),
  cartId: text('cart_id')
    .notNull()
    .references(() => carts.id, { onDelete: 'cascade' }),
  cartHash: text('cart_hash').notNull(),
  text: text('text').notNull(),
  fields: jsonb('fields').notNull(),
  textHash: text('text_hash').notNull(),
  spokenAt: ts('spoken_at'),
  holdOpen: boolean('hold_open').notNull().default(false),
  confirmedAt: ts('confirmed_at'),
  confirmation: jsonb('confirmation'),
  /** Hash over readback + confirmation evidence; bound into PayPal custom_id and request id. */
  readbackHash: text('readback_hash'),
  invalidatedAt: ts('invalidated_at'),
  createdAt: created(),
});

export const orders = pgTable(
  'orders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    cartId: text('cart_id').notNull(),
    readbackId: text('readback_id').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    paypalOrderId: text('paypal_order_id').unique(),
    paypalRequestId: text('paypal_request_id').notNull().unique(),
    intent: text('intent').notNull(),
    paymentSource: text('payment_source').notNull(),
    status: text('status').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    merchantId: text('merchant_id').notNull(),
    captureId: text('capture_id'),
    authorizationId: text('authorization_id'),
    authorizationExpiresAt: ts('authorization_expires_at'),
    receiptId: text('receipt_id'),
    title: text('title').notNull(),
    createdAt: created(),
    updatedAt: created(),
  },
  (t) => [index('orders_user_idx').on(t.userId, t.createdAt)],
);

export const vaultTokens = pgTable('vault_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  paypalCustomerId: text('paypal_customer_id'),
  vaultId: text('vault_id').notNull(),
  status: text('status').notNull(),
  label: text('label'),
  createdAt: created(),
});

export const shipments = pgTable('shipments', {
  orderId: text('order_id')
    .primaryKey()
    .references(() => orders.id, { onDelete: 'cascade' }),
  trackerId: text('tracker_id'),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  status: text('status').notNull(),
  shippedVariant: text('shipped_variant').notNull(),
  shippedAt: ts('shipped_at'),
  deliveredAt: ts('delivered_at'),
});

export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  photos: jsonb('photos').$type<{ kind: string; blobId: string; sha256: string }[]>().notNull().default([]),
  quality: jsonb('quality'),
  moduleOutputs: jsonb('module_outputs'),
  verdict: jsonb('verdict'),
  helperAnswer: jsonb('helper_answer'),
  createdAt: created(),
  updatedAt: created(),
});

export const evidencePacks = pgTable('evidence_packs', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  verificationId: text('verification_id'),
  manifest: jsonb('manifest').notNull(),
  manifestHash: text('manifest_hash').notNull(),
  narrative: text('narrative'),
  pdfBlobId: text('pdf_blob_id'),
  uploadedAt: ts('uploaded_at'),
  createdAt: created(),
});

export const cases = pgTable('cases', {
  id: text('id').primaryKey(),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  kind: text('kind').notNull(),
  paypalDisputeId: text('paypal_dispute_id').unique(),
  stage: text('stage').notNull(),
  status: text('status').notNull(),
  reason: text('reason').notNull(),
  dueAt: ts('due_at'),
  offers: jsonb('offers').$type<unknown[]>().notNull().default([]),
  outcome: jsonb('outcome'),
  evidencePackId: text('evidence_pack_id'),
  createdAt: created(),
  updatedAt: created(),
});

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  paypalEventId: text('paypal_event_id').notNull().unique(),
  type: text('type').notNull(),
  raw: text('raw').notNull(),
  signatureOk: boolean('signature_ok').notNull(),
  processedAt: ts('processed_at'),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  receivedAt: created(),
});

/** Append-only, hash-chained. */
export const auditLog = pgTable(
  'audit_log',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    userId: text('user_id'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subjectId: text('subject_id'),
    payload: jsonb('payload').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    createdAt: created(),
  },
  (t) => [index('audit_subject_idx').on(t.subjectId)],
);

export const receipts = pgTable('receipts', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  subjectId: text('subject_id'),
  body: jsonb('body').notNull(),
  hash: text('hash').notNull(),
  signature: text('signature').notNull(),
  /** Ed25519 over `hash` (base64url); verifiable offline with the published public key. */
  ed25519: text('ed25519'),
  createdAt: created(),
});

/** Ledger reservations so two confirmations cannot both pass the budget guard. */
export const reservations = pgTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    key: text('key').notNull().unique(),
    userId: text('user_id').notNull(),
    cartHash: text('cart_hash').notNull(),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull().default('USD'),
    status: text('status').notNull(),
    createdAt: ts('created_at').notNull(),
    expiresAt: ts('expires_at').notNull(),
    committedAt: ts('committed_at'),
    releasedAt: ts('released_at'),
    releaseReason: text('release_reason'),
  },
  (t) => [index('reservations_user_idx').on(t.userId, t.status)],
);

export const blobs = pgTable('blobs', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id'),
  sha256: text('sha256').notNull(),
  mime: text('mime').notNull(),
  bytes: bytea('bytes'),
  s3Key: text('s3_key'),
  size: integer('size').notNull(),
  createdAt: created(),
});

export const helperRequests = pgTable('helper_requests', {
  id: text('id').primaryKey(),
  verificationId: text('verification_id').notNull(),
  helperId: text('helper_id'),
  question: text('question').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  answer: jsonb('answer'),
  answeredAt: ts('answered_at'),
  revokedAt: ts('revoked_at'),
  createdAt: created(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    link: text('link'),
    readAt: ts('read_at'),
    createdAt: created(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.createdAt)],
);

export const pushSubscriptions = pgTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  userId: text('user_id').notNull(),
  keys: jsonb('keys').notNull(),
  createdAt: created(),
});

export const barrierAudits = pgTable('barrier_audits', {
  id: text('id').primaryKey(),
  storeDomainHash: text('store_domain_hash').notNull(),
  platform: text('platform').notNull(),
  urlKind: text('url_kind').notNull(),
  violations: jsonb('violations').notNull(),
  keyboardTraversal: jsonb('keyboard_traversal'),
  runAt: ts('run_at').notNull(),
});

export const evalRuns = pgTable('eval_runs', {
  id: text('id').primaryKey(),
  suite: text('suite').notNull(),
  gitSha: text('git_sha').notNull(),
  params: jsonb('params'),
  results: jsonb('results').notNull(),
  createdAt: created(),
});

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text('key').notNull(),
    scope: text('scope').notNull(),
    response: jsonb('response'),
    createdAt: created(),
  },
  (t) => [uniqueIndex('idem_scope_key').on(t.scope, t.key)],
);
