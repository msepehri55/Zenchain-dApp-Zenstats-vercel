// pages/admin.js
import Head from 'next/head';
import { useEffect, useMemo, useRef, useState } from 'react';

// Final categories for prizes (ci removed; cco merged into cc)
const CATEGORIES = [
  'stake',
  'native_send',
  'nft_mint',
  'domain_mint',
  'gm',
  'cc',
];

// Helper: convert any Google Sheets link to CSV export form
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

// Simple CSV parser (expects columns for discord + wallet/address; header optional)
// Note: basic splitting by comma; for complex CSVs, publish the sheet to the web (CSV) for clean parsing.
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

// Concurrency limiter for wallet fetches
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

// Map site categories so that 'cco' folds into 'cc', and ignore 'ci'
function canonicalizeCategory(c) {
  if (c === 'cco') return 'cc';
  if (c === 'ci') return null; // ignore
  return c;
}

// Apply leniency across deficits to maximize completed parts.
// Only categories with threshold > 0 are considered "parts".
function allocateLeniency(counts, thresholds, leniencyN) {
  const parts = Object.keys(thresholds).filter(c => Number(thresholds[c]) > 0);

  const deficits = parts
    .map(cat => {
      const need = Math.max(0, Number(thresholds[cat]) - Number(counts?.[cat] || 0));
      return { cat, need, used: 0 };
    })
    .filter(d => d.need > 0)
    .sort((a, b) => a.need - b.need); // small deficits first to maximize completed parts

  let remaining = Math.max(0, Number(leniencyN || 0));
  for (const d of deficits) {
    if (remaining <= 0) break;
    const take = Math.min(d.need, remaining);
    d.need -= take;
    d.used += take;
    remaining -= take;
  }

  const missedCats = deficits.filter(d => d.need > 0).map(d => d.cat);
  const missedAfter = missedCats.length;
  const leniencyUsed = Math.max(0, Number(leniencyN || 0) - remaining);

  return { missedAfter, missedCats, leniencyUsed };
}

export default function Admin() {
  // Data input
  const [sheetUrl, setSheetUrl] = useState('');
  const [csvText, setCsvText] = useState('');
  const [loadingSheet, setLoadingSheet] = useState(false);

  // Window
  const [period, setPeriod] = useState('7d'); // 24h, 7d, 30d, all, custom
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
  const [minTotal, setMinTotal] = useState(0);
  const [leniency, setLeniency] = useState(0); // ignore up to N tx across all parts
  const [groupByDiscord, setGroupByDiscord] = useState(true);
  const [showOnlyWinners, setShowOnlyWinners] = useState(true);
  const [concurrency, setConcurrency] = useState(3);

  // Results
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState([]); // aggregated per discord (if grouping) or per wallet
  const [winnersByGroup, setWinnersByGroup] = useState({ 0: [], 1: [], 2: [], 3: [] });
  const [winTab, setWinTab] = useState(0); // 0,1,2,3 tabs
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

  // Count per-category using your existing activity categories; merge cco->cc; ignore ci
  function computeCounts(activity) {
    const ext = activity.filter(r => r.kind === 'native');
    const counts = {};
    CATEGORIES.forEach(c => (counts[c] = 0));
    for (const r of ext) {
      const c0 = canonicalizeCategory(r.category);
      if (!c0) continue;
      if (counts[c0] == null) counts[c0] = 0;
      counts[c0] += 1;
    }
    const total = ext.length;
    return { counts, total };
  }

  async function run() {
    try {
      if (!windowParams) { alert('Pick a valid date range'); return; }
      const list = parseCsv(csvText);
      if (!list.length) { alert('No valid (discord, wallet) rows found in CSV'); return; }

      setStatus('Querying wallets...');
      setProgress({ done: 0, total: list.length });
      setResults([]);
      setWinnersByGroup({ 0: [], 1: [], 2: [], 3: [] });
      abortRef.current.aborted = false;

      const limit = pLimit(Math.max(1, Number(concurrency) || 3));

      const tasks = list.map(({ discord, wallet }) =>
        limit(async () => {
          if (abortRef.current.aborted) return null;
          const qs = `start=${windowParams.start}&end=${windowParams.end}`;
          const url = `/api/activity?address=${encodeURIComponent(wallet)}&${qs}`;
          const r = await fetch(url);
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || 'activity failed');
          const { counts, total } = computeCounts(j.activity || []);
          return { discord, wallet, counts, total };
        }).then((res) => {
          setProgress(p => ({ done: p.done + 1, total: p.total }));
          return res;
        })
      );

      const rows = (await Promise.all(tasks)).filter(Boolean);

      // Group by discord if needed
      let grouped = rows;
      if (groupByDiscord) {
        const map = new Map();
        for (const r of rows) {
          const key = r.discord;
          const cur = map.get(key) || { discord: key, wallets: [], counts: {}, total: 0 };
          cur.wallets.push(r.wallet);
          cur.total += Number(r.total || 0);
          for (const c of Object.keys(r.counts)) {
            cur.counts[c] = (Number(cur.counts[c] || 0) + Number(r.counts[c] || 0));
          }
          map.set(key, cur);
        }
        grouped = [...map.values()].map(x => ({
          discord: x.discord,
          wallet: x.wallets.join(' | '),
          counts: x.counts,
          total: x.total
        }));
      }

      // Evaluate with leniency and bucket winners into 0/1/2/3 missed parts
      const groups = { 0: [], 1: [], 2: [], 3: [] };

      const annotated = grouped.map(r => {
        const totalOk = Number(minTotal || 0) <= 0 ? true : (Number(r.total) >= Number(minTotal));
        const { missedAfter, leniencyUsed, missedCats } = allocateLeniency(r.counts, thresholds, leniency);

        // Winners pages: show 0..3 missed parts AFTER leniency
        const isWinner = totalOk && missedAfter <= 3;
        const out = { ...r, leniencyUsed, missedParts: missedAfter, missedCats, totalOk, isWinner };

        if (isWinner) {
          if (missedAfter === 0) groups[0].push(out);
          else if (missedAfter === 1) groups[1].push(out);
          else if (missedAfter === 2) groups[2].push(out);
          else if (missedAfter === 3) groups[3].push(out);
        }
        return out;
      });

      setResults(annotated);
      setWinnersByGroup(groups);

      const totals = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
      setStatus(`Done. Processed ${grouped.length} ${groupByDiscord ? 'participants' : 'wallets'}. Winners: ${totals} (0-miss: ${groups[0].length}, 1-miss: ${groups[1].length}, 2-miss: ${groups[2].length}, 3-miss: ${groups[3].length}).`);
    } catch (e) {
      console.error(e);
      alert(e.message || String(e));
      setStatus('');
    }
  }

  function downloadCsv(rows) {
    if (!rows.length) return;
    const header = ['discord', 'wallets', 'total', ...CATEGORIES, 'leniency_used', 'missed_parts', 'missed_list'];
    const lines = [header.join(',')];
    for (const r of rows) {
      const arr = [
        `"${String(r.discord || '').replace(/"/g, '""')}"`,
        `"${String(r.wallet || '').replace(/"/g, '""')}"`,
        r.total
      ];
      for (const c of CATEGORIES) arr.push(r.counts?.[c] || 0);
      arr.push(r.leniencyUsed || 0);
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

  // Which rows to show
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
        {/* Participants source */}
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
                <label className="text-sm text-slate-300">Min total external tx</label>
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
                  title="We will cover up to N shortfalls across all parts to count a participant as complete"
                />
              </div>

              <div className="min-w-[180px]">
                <label className="text-sm text-slate-300">Concurrency</label>
                <input
                  type="number"
                  min="1" max="6"
                  value={concurrency}
                  onChange={e=>setConcurrency(Number(e.target.value))}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[44px]"
                  title="How many wallets to check in parallel (2–4 recommended)"
                />
              </div>
            </div>

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

            {/* Winner tabs (0/1/2/3 missed parts after leniency) */}
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
                    <th className="px-3 py-2 text-left">Wallets</th>
                    <th className="px-3 py-2 text-left">Total</th>
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
                      <td className="px-3 py-2 font-mono text-xs">{r.wallet}</td>
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
          Notes: cc includes both direct deploys and CCO (merged). ci is excluded. Leniency covers total shortfalls across all thresholded categories; min total is not lenient.
        </footer>
      </main>
    </div>
  );
}