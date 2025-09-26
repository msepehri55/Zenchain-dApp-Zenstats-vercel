// pages/api/admin/proxy.js
export default async function handler(req, res) {
  try {
    const url = String(req.query.url || '');
    if (!url || !/^https:\/\/(docs\.google\.com|lh3\.googleusercontent\.com)/.test(url)) {
      return res.status(400).json({ error: 'Invalid or missing Google URL' });
    }
    const r = await fetch(url, { headers: { accept: 'text/csv,*/*' } });
    if (!r.ok) return res.status(r.status).json({ error: `Upstream ${r.status}` });
    const text = await r.text();
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: e.message || String(e) });
  }
}