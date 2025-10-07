// pages/api/activity.js
import { parseRange, buildActivity } from '../../lib/shared';

export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Please provide a valid wallet address (0x...)' });
    }
    const { start, end } = parseRange(req.query);
    const activity = await buildActivity({ address, start, end });

    // Only external/native tx for the main count (what users expect)
    const external = activity.filter(r => r.kind === 'native');
    const externalOut = external.filter(r => r.direction === 'out').length;
    const externalIn  = external.filter(r => r.direction === 'in').length;

    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.json({
      address: address.toLowerCase(),
      window: { start, end },
      // count = unique external tx; total = all unique tx (external + token + internal)
      count: external.length,
      total: activity.length,
      breakdown: {
        external: external.length,
        externalOut,
        externalIn,
        all: activity.length,
      },
      activity
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}