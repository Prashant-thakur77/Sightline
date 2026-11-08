import { PayPalActionUnavailableError } from './errors';

export interface LinkLike {
  href: string;
  rel: string;
  method?: string;
}

export interface HasLinks {
  links?: readonly LinkLike[] | null;
}

/** PayPal spells rels both ways ("make_offer", "payer-action"); compare them case- and separator-insensitively. */
function norm(rel: string): string {
  return rel
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
}

function lastPathSegment(href: string): string | undefined {
  const path = href.split(/[?#]/)[0] ?? '';
  const seg = path.split('/').filter(Boolean).pop();
  return seg;
}

/** The first link whose rel matches, or undefined. */
export function findLink(resource: HasLinks | null | undefined, rel: string): LinkLike | undefined {
  const want = norm(rel);
  return resource?.links?.find((l) => norm(l.rel) === want);
}

/**
 * True when the resource offers the action now: a link with that rel, or a POST link whose path ends in the
 * action name (some dispute links use rel "detail" style names but keep the action in the path).
 */
export function hasAction(resource: HasLinks | null | undefined, rel: string): boolean {
  if (findLink(resource, rel)) return true;
  const want = norm(rel);
  return Boolean(
    resource?.links?.some((l) => {
      const seg = lastPathSegment(l.href);
      return (l.method ?? 'GET').toUpperCase() !== 'GET' && seg !== undefined && norm(seg) === want;
    }),
  );
}

/** Throws a typed error, before any request is sent, when the action is not offered. */
export function requireAction(resource: HasLinks | null | undefined, rel: string, resourceId?: string): void {
  if (!hasAction(resource, rel))
    throw new PayPalActionUnavailableError(
      rel,
      resourceId,
      (resource?.links ?? []).map((l) => l.rel),
    );
}

/** Id at the end of the `self` link, e.g. the dispute id in a create-dispute response. */
export function idFromSelfLink(resource: HasLinks | null | undefined): string | undefined {
  const self = findLink(resource, 'self') ?? resource?.links?.[0];
  return self ? lastPathSegment(self.href) : undefined;
}
