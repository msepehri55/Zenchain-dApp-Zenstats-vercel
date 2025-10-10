// pages/api/activity.js
import { parseRange, buildActivity } from '../../lib/shared';

export default async function handler(req, res) {
  try {
    // Accept only GET for cache friendliness
    if (req.method && req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Please provide a valid wallet address (0x...)' });
    }

    const { start, end } = parseRange(req.query);
    const activity = await buildActivity({ address, start, end });

    // Counts = OUTGOING external (native) tx
    const external = activity.filter(r => r.kind === 'native');
    const externalOut = external.filter(r => r.direction === 'out');
    const externalIn  = external.filter(r => r.direction === 'in');

    // Cache at the edge briefly
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.json({
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
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}