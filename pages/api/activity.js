import { parseRange, buildActivity } from '../../lib/shared';

export default async function handler(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Please provide a valid wallet address (0x...)' });
    }
    const { start, end } = parseRange(req.query);
    const activity = await buildActivity({ address, start, end });
    res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=30');
    return res.json({ address: address.toLowerCase(), window: { start, end }, count: activity.length, activity });
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}