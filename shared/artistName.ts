// Deezer sometimes credits a collaboration to a single combined "A & B" artist
// object — with its own id and its own artist page — sitting alongside the real
// solo artists ("Marshmello & Omar LinX" next to "Marshmello"). These helpers
// spot that pattern so we don't surface two artists mashed into one page.
//
// An "&"/"+"/"x" in a name is NOT proof on its own — plenty of real acts use
// them (Above & Beyond, Simon & Garfunkel, Earth, Wind & Fire, Florence + the
// Machine). So callers ALWAYS pair `isLikelyCombinedCredit` with a stronger
// signal — a missing portrait — before treating an artist as a phantom credit;
// genuine bands reliably have artwork, these phantom credits don't.

/** Collaboration separators, each requiring surrounding whitespace so a
 *  one-word name is never split (and "Charli XCX" / "AC/DC" are untouched). */
const COLLAB_SEP = /\s(?:&|\+|x|vs\.?|feat\.?|ft\.?|featuring)\s/i;

/** Does this name read like a multi-artist collaboration credit? */
export function isLikelyCombinedCredit(name: string): boolean {
  return COLLAB_SEP.test(name);
}

/** The lead (first) artist of a combined credit — "Marshmello & Omar LinX" →
 *  "Marshmello". Returns the name unchanged when there's no separator. */
export function leadArtistName(name: string): string {
  const lead = name.split(COLLAB_SEP)[0]?.trim();
  return lead || name.trim();
}

/** A phantom combined-credit artist: a collab-shaped name with NO portrait.
 *  Requiring the missing picture keeps genuine "A & B" bands (which always have
 *  artwork) safe while catching Deezer's artwork-less collab credits. */
export function isPhantomArtist(a: {
  name: string;
  picture_url: string | null;
}): boolean {
  return !a.picture_url && isLikelyCombinedCredit(a.name);
}

/** MD5 of the empty string — Deezer builds one blank-image variant on it. */
const BLANK_IMAGE_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';

/** Deezer's blank/placeholder image URL. Mirrors the server's `is_blank_image`
 *  (deezer/mod.rs): the empty-hash form (".../images/artist//...", a `//` in the
 *  path) or the empty-string-md5 form. Needed on the client to recognise art
 *  that was persisted BEFORE the server started nulling these. */
export function isBlankImageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (url.includes(BLANK_IMAGE_MD5)) return true;
  const scheme = url.indexOf('://');
  const path = scheme >= 0 ? url.slice(scheme + 3) : url;
  return path.includes('//');
}

/** A usable artist portrait: present, not a blank placeholder, and an actual
 *  artist photo — NOT an album cover (`/images/cover/`). Onboarding and the bulk
 *  "add from your songs" seed store an album cover as a stand-in until the
 *  backfill can resolve the real face; this is how we tell the two apart. */
export function hasRealPortrait(url: string | null | undefined): boolean {
  return !!url && !isBlankImageUrl(url) && !url.includes('/images/cover/');
}

/** Saved art that should be upgraded to a real portrait: a non-null image that
 *  is a blank placeholder or an album cover, not an artist photo. Null art is
 *  "already resolved, none exists" and is NOT replaceable — so the backfill,
 *  which stores a real portrait or null, can never loop. */
export function isReplaceableArt(url: string | null | undefined): boolean {
  return !!url && !hasRealPortrait(url);
}

/**
 * Pick the artist a name most likely refers to, from a search-result list.
 * Deezer's artist search ranks by relevance, NOT popularity, and its index is
 * full of same-name impostors, tributes, and blank phantom credits — so a search
 * for "Drake" can return a 50-fan "Drake" (or a portrait-less collab credit)
 * ahead of the real 24M-fan Drake. Taking result [0] gets the wrong one.
 *
 * Prefer, in order: an exact-name match WITH a real portrait and the most fans;
 * then any exact-name match by fans; then any result with a real portrait by
 * fans; finally the first result. Returns null only for an empty list.
 */
export function pickArtistForName<
  T extends { name: string; picture_url: string | null; total_fans: number | null },
>(results: T[], name: string): T | null {
  if (results.length === 0) return null;
  const want = name.trim().toLowerCase();
  const byFans = (a: T, b: T) => (b.total_fans ?? 0) - (a.total_fans ?? 0);
  const exact = results.filter((a) => a.name.trim().toLowerCase() === want);
  const exactWithPortrait = exact
    .filter((a) => hasRealPortrait(a.picture_url))
    .sort(byFans);
  if (exactWithPortrait[0]) return exactWithPortrait[0];
  if (exact.length) return [...exact].sort(byFans)[0]!;
  const anyWithPortrait = results
    .filter((a) => hasRealPortrait(a.picture_url))
    .sort(byFans);
  return anyWithPortrait[0] ?? results[0]!;
}
