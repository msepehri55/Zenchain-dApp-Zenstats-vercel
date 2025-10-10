// pages/api/stats.js
import { parseRange, buildStats } from '../../lib/shared';

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Please provide a valid wallet address (0x...)' });
    }
    const { start, end } = parseRange(req.query);
    const kpis = await buildStats({ address, start, end });

    // Derived from buildActivity to avoid drift and double counting
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.json({
      address: address.toLowerCase(),
      window: { start, end },
      kpis
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}