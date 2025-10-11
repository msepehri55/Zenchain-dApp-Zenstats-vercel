// pages/api/stats.js
import { parseRange, buildStats } from '../../lib/shared';

// Ephemeral in-memory cache per serverless instance
const STATS_CACHE = globalThis.__ZEN_STATS_CACHE__ || new Map();
globalThis.__ZEN_STATS_CACHE__ = STATS_CACHE;

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
      const cached = cacheGet(STATS_CACHE, key);
      if (cached) {
        res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');
        return res.json(cached);
      }
    }

    const kpis = await buildStats({ address, start, end });

    const payload = {
      address: address.toLowerCase(),
      window: { start, end },
      kpis
    };

    cacheSet(STATS_CACHE, key, payload, 45_000);

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=45');
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}