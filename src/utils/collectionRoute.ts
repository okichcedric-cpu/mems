// Builds the href for /collection/[id].
//
// The name is encoded TWICE on purpose. expo-router decodes a dynamic
// segment into route state, then re-encodes the state back into a URL on
// every navigation change (getPathFromState). Its re-encoder
// (encodeURISegment in expo-router's getPathFromState-forks.js) walks the
// string one UTF-16 code unit at a time, so an emoji (a surrogate pair) is
// split into two lone surrogates and encodeURIComponent throws
// "URI malformed". Keeping the state value pure ASCII (the single-encoded
// name) avoids it; useLocalSearchParams() decodes it once more on the way
// out, so the screen still receives the real name.
export function collectionHref(name: string, ownerId?: string): string {
  const base = `/collection/${encodeURIComponent(encodeURIComponent(name))}`;
  return ownerId ? `${base}?ownerId=${encodeURIComponent(ownerId)}` : base;
}
