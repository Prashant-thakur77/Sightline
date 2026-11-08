/** One entry of PayPal's `details[]` error array. */
export interface PayPalErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue?: string;
  description?: string;
}

export interface PayPalErrorLink {
  href: string;
  rel: string;
  method?: string;
}

/** Base class so callers can catch everything this package throws with one `instanceof`. */
export class PayPalError extends Error {}

export interface PayPalApiErrorInit {
  status: number;
  name: string;
  message: string;
  debugId?: string;
  details?: PayPalErrorDetail[];
  links?: PayPalErrorLink[];
  method?: string;
  path?: string;
  requestId?: string;
}

/**
 * A non-2xx answer from PayPal (or a 2xx batch answer that carries errors).
 * `name` is PayPal's error name, for example `UNPROCESSABLE_ENTITY`, and `issue` is the first
 * `details[].issue`, for example `INSTRUMENT_DECLINED`.
 */
export class PayPalApiError extends PayPalError {
  readonly status: number;
  override readonly name: string;
  readonly debugId: string | undefined;
  readonly details: PayPalErrorDetail[];
  readonly issue: string | undefined;
  readonly links: PayPalErrorLink[];
  /** True for 429 and 5xx: the same call may succeed later with the same PayPal-Request-Id. */
  readonly retryable: boolean;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly requestId: string | undefined;

  constructor(init: PayPalApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.name = init.name;
    this.debugId = init.debugId;
    this.details = init.details ?? [];
    this.issue = this.details.find((d) => d.issue)?.issue;
    this.links = init.links ?? [];
    this.retryable = init.status === 429 || init.status >= 500;
    this.method = init.method;
    this.path = init.path;
    this.requestId = init.requestId;
  }
}

/** 422 with issue INSTRUMENT_DECLINED: ask the buyer for another way to pay, never retry as is. */
export class PayPalInstrumentDeclinedError extends PayPalApiError {}

/** The resource does not offer this action right now (its HATEOAS link or allowed option is absent). */
export class PayPalActionUnavailableError extends PayPalError {
  override readonly name = 'PayPalActionUnavailableError';
  constructor(
    readonly action: string,
    readonly resourceId: string | undefined,
    readonly available: string[],
    detail?: string,
  ) {
    super(
      `PayPal does not offer "${action}"${resourceId ? ` on ${resourceId}` : ''} right now.` +
        (detail ? ` ${detail}` : '') +
        (available.length ? ` Available: ${available.join(', ')}.` : ''),
    );
  }
}

/** Input rejected locally, before any request was sent. */
export class PayPalValidationError extends PayPalError {
  override readonly name = 'PayPalValidationError';
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
  }
}

/** PayPal answered 2xx but the body did not match the shape this package relies on. */
export class PayPalResponseShapeError extends PayPalError {
  override readonly name = 'PayPalResponseShapeError';
  constructor(
    readonly path: string,
    readonly issues: string[],
    readonly debugId?: string,
  ) {
    super(`Unexpected PayPal response for ${path}: ${issues.slice(0, 3).join('; ')}`);
  }
}

/** The network failed on every attempt. */
export class PayPalNetworkError extends PayPalError {
  override readonly name = 'PayPalNetworkError';
  readonly retryable = true;
  constructor(
    readonly path: string,
    readonly attempts: number,
    options?: { cause?: unknown },
  ) {
    super(`Network error calling PayPal ${path} after ${attempts} attempt(s).`, options);
  }
}

export function isInstrumentDeclined(err: unknown): err is PayPalInstrumentDeclinedError {
  return err instanceof PayPalInstrumentDeclinedError;
}
