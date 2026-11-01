// Optional what3words -> coordinates conversion. Needs W3W_API_KEY (free
// tier is fine for this volume). Without a key the words are stored and sent
// to you as a what3words.com link, which works just as well on a phone.

export async function toCoordinates(words, { fetchImpl = fetch } = {}) {
  const key = process.env.W3W_API_KEY;
  if (!key || !words) return undefined;
  try {
    const url = `https://api.what3words.com/v3/convert-to-coordinates?words=${encodeURIComponent(words)}&key=${encodeURIComponent(key)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(2000) });
    const j = await res.json();
    if (!j?.coordinates) return undefined;
    return { lat: j.coordinates.lat, lon: j.coordinates.lng, source: 'what3words', nearestPlace: j.nearestPlace };
  } catch {
    return undefined;
  }
}
