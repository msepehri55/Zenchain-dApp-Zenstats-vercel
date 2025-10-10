// pages/admin.js
import Head from 'next/head';
import { useEffect, useMemo, useRef, useState } from 'react';

// Prize categories (cco merged into cc, ci ignored; approve is display-only on main site)
const CATEGORIES = [
  'stake',
  'native_send',
  'nft_mint',
  'domain_mint',
  'gm',
  'cc',
  'swap',
  'add_liquidity',
  'remove_liquidity',
];

// Convert Google Sheet link to CSV export
function toCsvUrl(input) {
  try {
    const url = new URL(input);
    const m = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (m) {
      const id = m[1];
      const gid = url.searchParams.get('gid') || '0';
      return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    }
  } catch {}
  return input;
}

// CSV parser: columns for discord + wallet/address; header optional
function parseCsv(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(',').map(s => s.trim().toLowerCase());
  const hasHeader = header.some(h => /discord|username|wallet|address/.test(h));
  let idxDiscord = hasHeader ? header.findIndex(h => /discord|username/.test(h)) : 0;
  let idxWallet  = hasHeader ? header.findIndex(h => /wallet|address/.test(h))  : 1;
  if (idxDiscord === -1) idxDiscord = 0;
  if (idxWallet  === -1) idxWallet  = 1;

  const out = [];
  for (let i = hasHeader ? 1 : 0; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    const discord = cols[idxDiscord] || '';
    const wallet  = (cols[idxWallet] || '').toLowerCase();
    if (!/^0x[a-fA-F0-9]{40}$/.test(wallet)) continue;
    if (!discord) continue;
    out.push({ discord, wallet });
  }
  return out;
}

// Concurrency limiter
function pLimit(concurrency) {
  let active = 0;
  const q = [];
  const next = () => {
    active--;
    if (q.length) q.shift()();
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then((v) => { resolve(v); next(); }).catch((e) => { reject(e); next(); });
      };
      if (active < concurrency) run();
      else q.push(run);
    });
}

// Merge 'cco' -> 'cc', ignore 'ci'
function canonicalizeCategory(c) {
  if (c === 'cco') return 'cc';
  if (c === 'ci') return null;
  return c;
}

// Count per category from activity (OUTGOING external native only, exclude fails)
// This matches the main site's KPIs logic coming from buildStats.
function computeCounts(activity) {
  const extOut = (Array.isArray(activity) ? activity : [])
    .filter(r => r.kind === 'native' && r.direction === 'out' && r.category !== 'fail');
  const counts = {};
  CATEGORIES.forEach(c => (counts[c] = 0));
  for (const r of extOut) {
    const c0 = canonicalizeCategory(r.category);
    if (!c0) continue; // ignore ci/null
    if (counts[c0] == null) counts[c0] = 0;
    counts[c0] += 1;
  }
  const total = extOut.length; // total = only outgoing external native
  return { counts, total };
}

// Build raw deficits (no leniency) for categories+total
function buildDeficits(counts, thresholds, minTotal, totalCount) {
  const parts = [];

  // Category parts
  for (const cat of CATEGORIES) {
    const need = Math.max(0, Number(thresholds[cat] || 0) - Number(counts?.[cat] || 0));
    if (Number(thresholds[cat] || 0) > 0 && need > 0) {
      parts.push({ cat, need, isTotal: false, used: 0 });
    }
  }

  // Total part
  const tMin = Number(minTotal || 0);
  if (tMin > 0) {
    const tNeed = Math.max(0, tMin - Number(totalCount || 0));
    if (tNeed > 0) {
      parts.push({ cat: 'total', need: tNeed, isTotal: true, used: 0 });
    }
  }

  return parts;
}

// Apply leniency only to categories (not total)
function evaluateParticipant(counts, thresholds, minTotal, totalCount, leniencyN) {
  const pre = buildDeficits(counts, thresholds, minTotal, totalCount);
  const preMissedCats = pre.map(d => d.cat);
  const preMissed = preMissedCats.length;

  const catDeficits = pre.filter(d => !d.isTotal).sort((a, b) => a.need - b.need);
  const totalDeficit = pre.find(d => d.isTotal);

  let remaining = Math.max(0, Number(leniencyN || 0));
  for (const d of catDeficits) {
    if (remaining <= 0) break;
    const take = Math.min(d.need, remaining);
    d.need -= take;
    d.used += take;
    remaining -= take;
  }
  const leniencyUsed = Math.max(0, Number(leniencyN || 0) - remaining);

  const missedCatsAfter = [
    ...catDeficits.filter(d => d.need > 0).map(d => d.cat),
    ...(totalDeficit && totalDeficit.need > 0 ? ['total'] : []),
  ];
  const missedAfter = missedCatsAfter.length;

  return {
    preMissed,
    preMissedCats,
    missedAfter,
    missedCatsAfter,
    leniencyUsed
  };
}

export default function Admin() {
  // Data source
  const [sheetUrl, setSheetUrl] = useState('');
  const [csvText, setCsvText] = useState('');
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Date range
  const [period, setPeriod] = useState('7d');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const showingCustom = period === 'custom';
  const parseLocalDT = (s) => Math.floor(new Date(s).getTime() / 1000);

  // Thresholds and options
  const [thresholds, setThresholds] = useState(() => {
    const t = {};
    CATEGORIES.forEach(c => (t[c] = 0));
    return t;
  });
  const [minTotal, setMinTotal] = useState(0); // total = OUTGOING externals only
  const [leniency, setLeniency] = useState(0);
  const [groupByDiscord, setGroupByDiscord] = useState(true);
  const [showOnlyWinners, setShowOnlyWinners] = useState(true);
  const [concurrency, setConcurrency] = useState(6); // higher default for speed

  // Results
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]); // annotated rows
  const [winnersByGroup, setWinnersByGroup] = useState({ 0: [], 1: [], 2: [], 3: [] });
  const [winTab, setWinTab] = useState(0);
  const abortRef = useRef({ aborted: false });

  useEffect(() => {
    return () => { abortRef.current.aborted = true; };
  }, []);

  const windowParams = useMemo(() => {
    if (period === 'custom') {
      if (!start || !end) return null;
      return { start: parseLocalDT(start), end: parseLocalDT(end) };
    }
    const now = Math.floor(Date.now() / 1000);
    if (period === '24h') return { start: now - 24*60*60, end: now };
    if (period === '7d')  return { start: now - 7*24*60*60,  end: now };
    if (period === '30d') return { start: now - 30*24*60*60, end: now };
    if (period === 'all') return { start: 0, end: now };
    return null;
  }, [period, start, end]);

  async function loadSheet() {
    try {
      setLoadingSheet(true);
      const url = toCsvUrl(sheetUrl.trim());
      if (!url) { alert('Paste a Google Sheet link'); return; }
      const r = await fetch(`/api/admin/proxy?url=${encodeURIComponent(url)}`);
      const text = await r.text();
      if (!r.ok) throw new Error(text || 'Failed to fetch sheet');
      setCsvText(text);
    } catch (e) {
      alert(e.message || String(e));
    } finally {
      setLoadingSheet(false);
    }
  }

  // SPEED: deduplicate wallet fetches. Each unique wallet is fetched once, then we aggregate by Discord.
  async function run() {
    try {
      if (!windowParams) { alert('Pick a valid date range'); return; }
      const rawList = parseCsv(csvText);
      if (!rawList.length) { alert('No valid (discord, wallet) rows found in CSV'); return; }

      // Build discord -> wallets map and unique wallet list
      const discToWallets = new Map();
      for (const row of rawList) {
        const d = row.discord.trim();
        const w = row.wallet.toLowerCase();
        if (!discToWallets.has(d)) discToWallets.set(d, new Set());
        discToWallets.get(d).add(w);
      }
      const uniqueWallets = [...new Set(rawList.map(r => r.wallet.toLowerCase()))];

      setStatus('Querying wallets (deduplicated)…');
      setProgress({ done: 0, total: uniqueWallets.length });
      setResults([]);
      setWinnersByGroup({ 0: [], 1: [], 2: [], 3: [] });
      abortRef.current.aborted = false;

      const limit = pLimit(Math.max(1, Number(concurrency) || 6));

      // Fetch each unique wallet once via /api/activity to mirror main page logic
      const walletResults = new Map(); // wallet -> { counts, total }
      const tasks = uniqueWallets.map((wallet) =>
        limit(async () => {
          if (abortRef.current.aborted) return null;
          const qs = `start=${windowParams.start}&end=${windowParams.end}`;
          const url = `/api/activity?address=${encodeURIComponent(wallet)}&${qs}`;
          const r = await fetch(url);
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || 'activity failed');

          // Compute counts exactly as main page KPIs do (OUTGOING external native only)
          const { counts, total } = computeCounts(j.activity || []);
          return { wallet, counts, total };
        }).then((res) => {
          setProgress(p => ({ done: p.done + 1, total: p.total }));
          if (res) walletResults.set(res.wallet, res);
          return res;
        })
      );

      await Promise.all(tasks);

      // Aggregate by Discord (sum across that Discord's wallets), or keep per wallet if grouping=off
      let grouped = [];
      if (groupByDiscord) {
        for (const [discord, ws] of discToWallets.entries()) {
          const counts = {};
          CATEGORIES.forEach(c => (counts[c] = 0));
          let total = 0;

          for (const w of ws) {
            const r = walletResults.get(w);
            if (!r) continue;
            total += Number(r.total || 0);
            for (const c of Object.keys(r.counts || {})) {
              counts[c] = (Number(counts[c] || 0) + Number(r.counts[c] || 0));
            }
          }

          grouped.push({
            discord,
            counts,
            total,
          });
        }
      } else {
        // one row per wallet (Discord shown; wallets column is not displayed per your request)
        grouped = rawList.map(({ discord, wallet }) => {
          const r = walletResults.get(wallet.toLowerCase()) || { counts: {}, total: 0 };
          return { discord, counts: r.counts || {}, total: r.total || 0 };
        });
      }

      // Evaluate with leniency
      const groups = { 0: [], 1: [], 2: [], 3: [] };
      const annotated = grouped.map(r => {
        const ev = evaluateParticipant(r.counts, thresholds, minTotal, r.total, leniency);
        const out = {
          ...r,
          leniencyUsed: ev.leniencyUsed,
          preMissed: ev.preMissed,
          preMissedCats: ev.preMissedCats,
          missedParts: ev.missedAfter,
          missedCats: ev.missedCatsAfter
        };
        if (out.missedParts <= 3) groups[out.missedParts].push(out);
        return out;
      });

      setResults(annotated);
      setWinnersByGroup(groups);

      const totals = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
      setStatus(`Done. Processed ${grouped.length} ${groupByDiscord ? 'participants' : 'rows'} (unique wallets: ${uniqueWallets.length}). Winners: ${totals} (0-miss: ${groups[0].length}, 1-miss: ${groups[1].length}, 2-miss: ${groups[2].length}, 3-miss: ${groups[3].length}).`);
    } catch (e) {
      console.error(e);
      alert(e.message || String(e));
      setStatus('');
    }
  }

  function downloadCsv(rows) {
    if (!rows.length) return;
    const header = [
      'discord', 'total_outgoing',
      ...CATEGORIES,
      'leniency_used',
      'pre_missed_parts', 'pre_missed_list',
      'missed_parts', 'missed_list'
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      const arr = [
        `"${String(r.discord || '').replace(/"/g, '""')}"`,
        r.total
      ];
      for (const c of CATEGORIES) arr.push(r.counts?.[c] || 0);
      arr.push(r.leniencyUsed || 0);
      arr.push(r.preMissed || 0);
      arr.push(`"${(r.preMissedCats || []).join('|').replace(/"/g,'""')}"`);
      arr.push(r.missedParts ?? '');
      arr.push(`"${(r.missedCats || []).join('|').replace(/"/g,'""')}"`);
      lines.push(arr.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zenstats-${showOnlyWinners ? 'winners' : 'results'}-${Date.now()}.csv`;
    a.click();
  }

  const currentWinnerRows = winnersByGroup[winTab] || [];
  const rowsToShow = showOnlyWinners ? currentWinnerRows : results;

  return (
    <div className="min-h-screen text-slate-100">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>ZenStats Admin — Awards</title>
      </Head>

      <header className="border-b border-slate-800 sticky top-0 bg-slate-950/70 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <img src="/zen-logo.png" alt="Zenchain" onError={e=>e.currentTarget.style.display='none'} className="h-8 w-8 rounded" />
          <span className="text-lg sm:text-xl font-semibold bg-gradient-to-r from-lime-300 via-emerald-300 to-teal-300 bg-clip-text text-transparent">ZenStats — Admin</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {/* Participants */}
        <section className="glass rounded-xl p-4 border border-slate-800">
          <h2 className="text-lg font-semibold mb-3">Participants</h2>
          <div className="grid gap-3">
            <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-end">
              <div className="flex-1">
                <label className="text-sm text-slate-300">Google Sheet link (auto-converts to CSV)</label>
                <div className="flex gap-2">
                  <input
                    value={sheetUrl}
                    onChange={e=>setSheetUrl(e.target.value)}
                    placeholder="https://docs.google.com/spreadsheets/d/..../edit?gid=0"
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 outline-none focus:ring-2 focus:ring-emerald-400 min-h-[44px]"
                  />
                  <button
                    onClick={loadSheet}
                    className="mt-1 inline-flex items-center justify-center px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 min-w-[120px]"
                    disabled={loadingSheet}
                  >
                    {loadingSheet ? 'Loading…' : 'Fetch CSV'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-400">Ensure the sheet is shared to “Anyone with the link” or publish to the web.</p>
              </div>
            </div>

            <div>
              <label className="text-sm text-slate-300">Or paste CSV (discord,wallet)</label>
              <textarea
                value={csvText}
                onChange={e=>setCsvText(e.target.value)}
                rows={5}
                placeholder={`discordUser#1234,0xabc123...`}
                className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700"
              />
            </div>
          </div>
        </section>

        {/* Filters */}
        <section className="mt-6 glass rounded-xl p-4 border border-slate-800">
          <h2 className="text-lg font-semibold mb-3">Filters</h2>
          <div className="grid gap-4">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="min-w-[180px]">
                <label className="text-sm text-slate-300">Range</label>
                <select
                  value={period}
                  onChange={e=>setPeriod(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]"
                >
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="all">All time</option>
                  <option value="custom">Custom…</option>
                </select>
              </div>
              {showingCustom && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-sm text-slate-300">Start</label>
                    <input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]" />
                  </div>
                  <div>
                    <label className="text-sm text-slate-300">End</label>
                    <input type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]" />
                  </div>
                </div>
              )}

              <div className="min-w-[180px]">
                <label className="text-sm text-slate-300">Min total external tx (outgoing only)</label>
                <input
                  type="number"
                  min="0"
                  value={minTotal}
                  onChange={e=>setMinTotal(Number(e.target.value))}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]"
                />
              </div>

              <div className="min-w-[180px]">
                <label className="text-sm text-slate-300">Leniency (ignore up to N tx)</label>
                <input
                  type="number"
                  min="0"
                  value={leniency}
                  onChange={e=>setLeniency(Number(e.target.value))}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]"
                  title="Covers shortfalls across category parts only; not applied to total"
                />
              </div>

              <div className="min-w-[180px]">
                <label className="text-sm text-slate-300">Concurrency</label>
                <input
                  type="number"
                  min="1" max="12"
                  value={concurrency}
                  onChange={e=>setConcurrency(Number(e.target.value))}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]"
                  title="How many wallets to check in parallel (higher = faster; 5–8 recommended)"
                />
              </div>
            </div>

            {/* Per-category thresholds */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
              {CATEGORIES.map(cat => (
                <div key={cat}>
                  <label className="text-xs text-slate-300">Min {cat.replace('_',' ')}</label>
                  <input
                    type="number"
                    min="0"
                    value={thresholds[cat]}
                    onChange={e=>setThresholds(prev => ({ ...prev, [cat]: Number(e.target.value) }))}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center gap-4 flex-wrap">
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={groupByDiscord} onChange={e=>setGroupByDiscord(e.target.checked)} />
                <span>Group by Discord (sum across multiple wallets)</span>
              </label>
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" checked={showOnlyWinners} onChange={e=>setShowOnlyWinners(e.target.checked)} />
                <span>Show only winners</span>
              </label>
              <button
                onClick={run}
                className="ml-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-lime-400 via-emerald-400 to-teal-400 text-slate-900 font-semibold min-h-[44px]"
              >
                Run
              </button>
            </div>

            <p className="text-sm text-slate-300" aria-live="polite">
              {status} {progress.total ? `• ${progress.done} / ${progress.total}` : ''}
            </p>
          </div>
        </section>

        {/* Winners/results */}
        <section className="mt-6 glass rounded-xl p-4 border border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {showOnlyWinners ? 'Winners' : 'All Participants'}
            </h2>

            {/* Tabs: missed parts AFTER leniency (total counts as part; not lenient) */}
            {showOnlyWinners && (
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  { k: 0, label: 'Completed all' },
                  { k: 1, label: 'Missed 1 part' },
                  { k: 2, label: 'Missed 2 parts' },
                  { k: 3, label: 'Missed 3 parts' },
                ].map(tab => (
                  <button
                    key={tab.k}
                    onClick={() => setWinTab(tab.k)}
                    className={`px-3 py-2 rounded min-h-[40px] ${
                      winTab === tab.k ? 'bg-emerald-600/30 border border-emerald-400/40' : 'bg-slate-800 hover:bg-slate-700'
                    }`}
                  >
                    {tab.label} ({(winnersByGroup[tab.k] || []).length})
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={() => downloadCsv(rowsToShow)}
              disabled={!rowsToShow.length}
              className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 min-h-[40px]"
            >
              Download CSV
            </button>
          </div>

          {!rowsToShow.length ? (
            <p className="mt-3 text-slate-300">No rows.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-slate-400">
                  <tr className="border-b border-slate-800">
                    <th className="px-3 py-2 text-left">Discord</th>
                    <th className="px-3 py-2 text-left">Total (outgoing)</th>
                    {CATEGORIES.map(c => (
                      <th key={c} className="px-3 py-2 text-left">{c.replace('_',' ')}</th>
                    ))}
                    <th className="px-3 py-2 text-left">Leniency used</th>
                    <th className="px-3 py-2 text-left">Missed parts</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsToShow.map((r, i) => (
                    <tr key={i} className="border-b border-slate-800">
                      <td className="px-3 py-2">{r.discord}</td>
                      <td className="px-3 py-2">{r.total}</td>
                      {CATEGORIES.map(c => (
                        <td key={c} className="px-3 py-2">{r.counts?.[c] || 0}</td>
                      ))}
                      <td className={`px-3 py-2 ${Number(r.leniencyUsed || 0) > 0 ? 'text-emerald-300' : ''}`}>{r.leniencyUsed || 0}</td>
                      <td className="px-3 py-2">{r.missedParts ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="text-slate-400 text-sm mt-8 pb-safe">
          Notes: totals and category counts use ONLY outgoing external native tx (matches main page). Wallets are fetched once (dedup) for speed; winners table shows only Discord per your request.
        </footer>
      </main>
    </div>
  );
}