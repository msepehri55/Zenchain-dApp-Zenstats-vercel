// pages/api/activity.js
import { parseRange, buildActivity } from '../../lib/shared';

// Ephemeral in-memory cache per serverless instance (helps Admin batching)
const ACTIVITY_CACHE = globalThis.__ZEN_ACTIVITY_CACHE__ || new Map();
globalThis.__ZEN_ACTIVITY_CACHE__ = ACTIVITY_CACHE;

function cacheKey(address, start, end) {
  return `${address.toLowerCase()}::${start}::${end}`;
}
function cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { map.delete(key); return null; }
  return e.val;
}
function cacheSet(map, key, val, ttlMs) {
  map.set(key, { val, exp: Date.now() + ttlMs });
}

export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Please provide a valid wallet address (0x...)' });
    }
    const { start, end } = parseRange(req.query);

    const force = String(req.query.force || '').toLowerCase() === '1';
    const key = cacheKey(address, start, end);

    if (!force) {
      const cached = cacheGet(ACTIVITY_CACHE, key);
      if (cached) {
        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');
        return res.json(cached);
      }
    }

    const activity = await buildActivity({ address, start, end });

    // Original behavior: count only OUTGOING external (native) tx
    const external = activity.filter(r => r.kind === 'native');
    const externalOut = external.filter(r => r.direction === 'out');
    const externalIn  = external.filter(r => r.direction === 'in');

    const payload = {
      address: address.toLowerCase(),
      window: { start, end },
      count: externalOut.length,       // main count = OUTGOING external only
      breakdown: {
        externalOut: externalOut.length,
        externalIn: externalIn.length,
        externalAll: external.length,
        allUniqueRows: activity.length
      },
      activity
    };

    // short-lived cache to smooth bursts (Admin tool)
    cacheSet(ACTIVITY_CACHE, key, payload, 45_000);

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}