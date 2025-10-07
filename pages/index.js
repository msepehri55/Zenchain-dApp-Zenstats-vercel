import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';

export default function Home() {
  const [addr, setAddr] = useState('');
  const [period, setPeriod] = useState('24h'); // 24h -> 7d -> 30d -> all -> custom
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [status, setStatus] = useState('');
  const [kpis, setKpis] = useState(null);
  const [activity, setActivity] = useState([]);

  const [cat, setCat] = useState('all');
  const [dir, setDir] = useState('out');
  const [sort, setSort] = useState('time.desc');
  const [botSec, setBotSec] = useState(5);

  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [botCount, setBotCount] = useState(0);

  // Mobile detection for responsive rendering (card view)
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(max-width: 640px)');
    const handler = (e) => setIsMobile(e.matches);
    setIsMobile(mql.matches);
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else mql.addListener(handler);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else mql.removeListener(handler);
    };
  }, []);

  // Default to smaller page size on mobile
  useEffect(() => {
    setPageSize((ps) => (isMobile && ps > 10 ? 10 : ps));
  }, [isMobile]);

  const showingCustom = period === 'custom';

  function fmtTime(ms) { return new Date(ms).toLocaleString(); }
  function shortHash(h) { return h ? h.slice(0,10) + '…' + h.slice(-8) : ''; }
  function shortAddr(a) { return a ? a.slice(0,8) + '…' + a.slice(-6) : ''; }
  function parseLocalDT(s) { return Math.floor(new Date(s).getTime()/1000); }

  function catBadge(c) {
    // colors for all categories we use
    const map = {
      domain_mint:      'bg-lime-800/35 text-lime-300 ring-1 ring-lime-400/30',
      nft_mint:         'bg-violet-800/35 text-violet-300 ring-1 ring-violet-400/30',
      stake:            'bg-teal-800/35 text-teal-300 ring-1 ring-teal-400/30',
      gm:               'bg-indigo-800/35 text-indigo-300 ring-1 ring-indigo-400/30',
      native_send:      'bg-amber-800/35 text-amber-300 ring-1 ring-amber-400/30',
      cc:               'bg-rose-800/35 text-rose-300 ring-1 ring-rose-400/30',
      cco:              'bg-fuchsia-800/35 text-fuchsia-300 ring-1 ring-fuchsia-400/30',
      ci:               'bg-cyan-800/35 text-cyan-300 ring-1 ring-cyan-400/30',
      swap:             'bg-sky-800/35 text-sky-300 ring-1 ring-sky-400/30',
      add_liquidity:    'bg-emerald-800/35 text-emerald-300 ring-1 ring-emerald-400/30',
      remove_liquidity: 'bg-orange-800/35 text-orange-300 ring-1 ring-orange-400/30',
      approve:          'bg-blue-800/35 text-blue-300 ring-1 ring-blue-400/30',
      fail:             'bg-red-800/35 text-red-300 ring-1 ring-red-400/30',
      other:            'bg-slate-800 text-slate-300 ring-1 ring-slate-600/30'
    };
    const key = (c || 'other');
    const cls = map[key] || map.other;
    return <span className={`text-[11px] px-2 py-1 rounded ${cls}`}>{String(key).replace(/_/g,' ')}</span>;
  }

  function computeBotFlags(rows) {
    const onlyNative = rows.filter(r => r.kind === 'native');
    const sorted = [...onlyNative].sort((a,b) => a.timeMs - b.timeMs);
    const t = Number(botSec || 5) * 1000;
    const set = new Set();
    for (let i=1;i<sorted.length;i++) {
      if (sorted[i].timeMs - sorted[i-1].timeMs <= t) {
        set.add(sorted[i].hash); set.add(sorted[i-1].hash);
      }
    }
    setBotCount(set.size);
    return set;
  }

  const filteredSortedRows = useMemo(() => {
    let rows = [...activity];
    if (cat !== 'all') rows = rows.filter(r => (r.category || 'none') === cat);
    if (dir !== 'all') rows = rows.filter(r => r.direction === dir);
    const [key, d] = sort.split('.');
    rows.sort((a,b) => {
      if (key === 'time') return d === 'desc' ? b.timeMs - a.timeMs : a.timeMs - b.timeMs;
      if (key === 'value') return d === 'desc'
        ? (Number(b.valueNorm || 0) - Number(a.valueNorm || 0))
        : (Number(a.valueNorm || 0) - Number(b.valueNorm || 0));
      return 0;
    });
    return rows;
  }, [activity, cat, dir, sort]);

  const totalPages = Math.max(1, Math.ceil(filteredSortedRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows = useMemo(() => {
    const startIdx = (currentPage - 1) * pageSize;
    return filteredSortedRows.slice(startIdx, startIdx + pageSize);
  }, [filteredSortedRows, currentPage, pageSize]);

  const botFlags = useMemo(() => computeBotFlags(filteredSortedRows), [filteredSortedRows, botSec]);

  function DesktopTable() {
    if (!pageRows.length) return <p className="text-slate-300">No records in this window.</p>;
    const trs = pageRows.map(r => {
      const txUrl = 'https://zentrace.io/tx/' + (r.hash || '');
      const fromUrl = 'https://zentrace.io/address/' + (r.from || '');
      const toUrl = 'https://zentrace.io/address/' + (r.to || '');
      const amt = r.kind === 'native' || r.kind === 'internal'
        ? (r.value + ' ZTC')
        : (r.standard === 'erc20' ? `${r.amount} ${r.symbol || 'TOKEN'}` : (r.standard === 'erc721' ? `tokenId ${r.tokenId || ''} ${r.symbol || 'NFT'}` : ''));
      const highlight = botFlags.has(r.hash) ? 'bg-amber-900/20' : '';
      return (
        <tr key={r.hash} className={`border-b border-slate-800 ${highlight}`}>
          <td className="px-3 py-2">{fmtTime(r.timeMs)}</td>
          <td className="px-3 py-2">{r.category ? <>{catBadge(r.category)} </> : null}<span className="text-xs text-slate-400">{r.direction || ''}</span></td>
          <td className="px-3 py-2 font-mono"><a className="text-emerald-300 hover:underline" href={txUrl} target="_blank" rel="noreferrer">{shortHash(r.hash)}</a></td>
          <td className="px-3 py-2 font-mono"><a className="text-emerald-300 hover:underline" href={fromUrl} target="_blank" rel="noreferrer">{shortAddr(r.from)}</a></td>
          <td className="px-3 py-2 font-mono"><a className="text-emerald-300 hover:underline" href={toUrl} target="_blank" rel="noreferrer">{shortAddr(r.to)}</a></td>
          <td className="px-3 py-2 font-mono">{amt}</td>
        </tr>
      );
    });
    return (
      <div className="overflow-x-auto touch-scroll">
        <table className="min-w-full text-sm">
          <thead className="text-slate-400">
            <tr className="border-b border-slate-800">
              <th className="px-3 py-2 text-left">Time</th>
              <th className="px-3 py-2 text-left">Category / Direction</th>
              <th className="px-3 py-2 text-left">Tx Hash</th>
              <th className="px-3 py-2 text-left">From</th>
              <th className="px-3 py-2 text-left">To</th>
              <th className="px-3 py-2 text-left">Amount</th>
            </tr>
          </thead>
          <tbody>{trs}</tbody>
        </table>
      </div>
    );
  }

  function MobileCards() {
    if (!pageRows.length) return <p className="text-slate-300">No records in this window.</p>;
    return (
      <div className="grid gap-2">
        {pageRows.map(r => {
          const txUrl = 'https://zentrace.io/tx/' + (r.hash || '');
          const fromUrl = 'https://zentrace.io/address/' + (r.from || '');
          const toUrl = 'https://zentrace.io/address/' + (r.to || '');
          const amt = r.kind === 'native' || r.kind === 'internal'
            ? (r.value + ' ZTC')
            : (r.standard === 'erc20' ? `${r.amount} ${r.symbol || 'TOKEN'}` : (r.standard === 'erc721' ? `tokenId ${r.tokenId || ''} ${r.symbol || 'NFT'}` : ''));
          const highlight = botFlags.has(r.hash) ? 'ring-1 ring-amber-500/40' : '';

          return (
            <div key={r.hash} className={`mobile-card glass border border-slate-800 ${highlight}`}>
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-400">{fmtTime(r.timeMs)}</div>
                <div className="flex items-center gap-2">
                  {r.category ? catBadge(r.category) : null}
                  <span className="text-[10px] text-slate-400">{r.direction || ''}</span>
                </div>
              </div>
              <div className="mt-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-slate-400">Tx:</span>
                  <a className="font-mono text-emerald-300 hover:underline" href={txUrl} target="_blank" rel="noreferrer">{shortHash(r.hash)}</a>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-400">From:</span>
                  <a className="font-mono text-emerald-300 hover:underline" href={fromUrl} target="_blank" rel="noreferrer">{shortAddr(r.from)}</a>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-400">To:</span>
                  <a className="font-mono text-emerald-300 hover:underline" href={toUrl} target="_blank" rel="noreferrer">{shortAddr(r.to)}</a>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-400">Amount:</span>
                  <span className="font-mono">{amt}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  async function load() {
    try {
      const a = addr.trim();
      if (!/^0x[a-fA-F0-9]{40}$/.test(a)) { alert('Please paste a valid 0x wallet address'); return; }
      let statsUrl = `/api/stats?address=${encodeURIComponent(a)}`;
      let actUrl   = `/api/activity?address=${encodeURIComponent(a)}`;
      if (period === 'custom') {
        if (!start || !end) { alert('Pick start and end date/time'); return; }
        statsUrl += `&start=${parseLocalDT(start)}&end=${parseLocalDT(end)}`;
        actUrl   += `&start=${parseLocalDT(start)}&end=${parseLocalDT(end)}`;
      } else {
        statsUrl += `&period=${period}`;
        actUrl   += `&period=${period}`;
      }
      setStatus('Loading… (large windows can take longer)');
      setPage(1);

      const ac = new AbortController();
      const sFetch = fetch(statsUrl, { signal: ac.signal });
      const aFetch = fetch(actUrl, { signal: ac.signal });
      const [sRes, aRes] = await Promise.all([sFetch, aFetch]);
      const [sJson, aJson] = await Promise.all([sRes.json(), aRes.json()]);
      if (!sRes.ok) throw new Error(sJson.error || 'Stats failed');
      if (!aRes.ok) throw new Error(aJson.error || 'Activity failed');

      setKpis(sJson.kpis || null);
      setActivity(aJson.activity || []);
      const w = sJson.window || aJson.window || {};
      const st = w.start ? new Date(w.start*1000).toLocaleString() : '';
      const en = w.end   ? new Date(w.end*1000).toLocaleString() : '';
      setStatus(`Window: ${st} → ${en} • ${aJson.count || 0} rows`);
    } catch (e) {
      console.error(e);
      alert(e.message || String(e));
      setStatus('');
    }
  }

  return (
    <div className="min-h-screen text-slate-100">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Zenchain Testnet — Wallet Stats</title>
      </Head>

      <header className="border-b border-slate-800 sticky top-0 bg-slate-950/70 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-3">
          <img src="/zen-logo.png" alt="Zenchain" onError={e=>e.currentTarget.style.display='none'} className="h-8 w-8 rounded" />
          <span className="text-lg sm:text-xl font-semibold bg-gradient-to-r from-lime-300 via-emerald-300 to-teal-300 bg-clip-text text-transparent">Zenchain Testnet — Wallet Stats</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-4">
        {/* Search / Controls */}
        <section className="glass rounded-xl p-4 border border-slate-800">
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-end">
            <div className="flex-1 w-full">
              <label className="text-sm text-slate-300">Wallet address</label>
              <input
                value={addr}
                onChange={e=>setAddr(e.target.value)}
                placeholder="0x..."
                className="mt-1 w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 outline-none focus:ring-2 focus:ring-emerald-400 min-h-[44px]"
              />
            </div>
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
              <div className="grid grid-cols-2 gap-2 w-full md:w-auto">
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
            <button
              onClick={load}
              className="mt-1 md:mt-6 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gradient-to-r from-lime-400 via-emerald-400 to-teal-400 text-slate-900 font-semibold min-h-[44px]"
            >
              Check Stats
            </button>
          </div>
          <p className="mt-3 text-sm text-slate-300" aria-live="polite">{status}</p>
        </section>

        {/* KPIs */}
        <section className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-10 gap-4">
          {kpis && ([
            { label: 'Stake Actions',    value: kpis.stakeActions, emoji: '🪙' },
            { label: 'Native Sends (ZTC)', value: kpis.nativeSends, emoji: '📤' },
            { label: 'NFT Mints',        value: kpis.nftMints, emoji: '🖼️' },
            { label: 'Domain Mints',     value: kpis.domainMints, emoji: '🌐' },
            { label: 'Deploys (CC+CCO)', value: kpis.ccCount, emoji: '🛠️' },
            { label: 'On‑chain GM',      value: kpis.gmCount, emoji: '🌞' },
            { label: 'Swaps',            value: kpis.swapCount ?? 0, emoji: '🔄' },
            { label: 'Add Liquidity',    value: kpis.addLiquidityCount ?? 0, emoji: '💧➕' },
            { label: 'Remove Liquidity', value: kpis.removeLiquidityCount ?? 0, emoji: '💧➖' },
            { label: 'Bridged',          value: 'Coming soon', emoji: '' }
          ].map((c, i) => (
            <div key={i} className="glass border border-slate-800 rounded-xl p-4 text-center">
              <div className="text-xs sm:text-sm text-slate-300">{c.label}</div>
              <div className="mt-1 text-2xl sm:text-3xl font-bold bg-gradient-to-r from-lime-300 via-emerald-300 to-teal-300 bg-clip-text text-transparent">{c.value}</div>
              {c.emoji ? <div className="mt-2 text-lg sm:text-xl">{c.emoji}</div> : null}
            </div>
          )))}
        </section>

        {/* Table controls */}
        <section className="mt-8 glass rounded-xl p-4 border border-slate-800">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <h2 className="text-lg font-semibold">All Transactions</h2>
              <div className="flex flex-wrap gap-2">
                <select value={cat} onChange={e=>{setCat(e.target.value); setPage(1);}} className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]">
                  <option value="all">Category: All</option>
                  <option value="nft_mint">Category: NFT mint</option>
                  <option value="domain_mint">Category: Domain mint</option>
                  <option value="stake">Category: Stake</option>
                  <option value="gm">Category: GM</option>
                  <option value="swap">Category: Swap</option>
                  <option value="add_liquidity">Category: Add Liquidity</option>
                  <option value="remove_liquidity">Category: Remove Liquidity</option>
                  <option value="approve">Category: Approve</option>
                  <option value="native_send">Category: Native send</option>
                  <option value="cc">Category: CC (deploy)</option>
                  <option value="cco">Category: CCO (deploy via 0x016e...8be0)</option>
                  <option value="ci">Category: CI (interact)</option>
                  <option value="fail">Category: Fail</option>
                  <option value="other">Category: Other</option>
                </select>
                <select value={dir} onChange={e=>{setDir(e.target.value); setPage(1);}} className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]">
                  <option value="out">Direction: Out</option>
                  <option value="all">Direction: All</option>
                  <option value="in">Direction: In</option>
                </select>
                <select value={sort} onChange={e=>{setSort(e.target.value); setPage(1);}} className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]">
                  <option value="time.desc">Sort: Time (newest)</option>
                  <option value="time.asc">Sort: Time (oldest)</option>
                  <option value="value.desc">Sort: Amount (high → low)</option>
                  <option value="value.asc">Sort: Amount (low → high)</option>
                </select>
                <select value={pageSize} onChange={e=>{setPageSize(Number(e.target.value)); setPage(1);}} className="px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]">
                  <option value={10}>Rows: 10</option>
                  <option value={25}>Rows: 25</option>
                  <option value={50}>Rows: 50</option>
                  <option value={100}>Rows: 100</option>
                </select>
              </div>
            </div>

            {/* Desktop table or Mobile cards */}
            <div className="sm:block hidden">
              <DesktopTable />
            </div>
            <div className="sm:hidden block">
              <MobileCards />
            </div>

            {/* Bot + pagination */}
            <div className="mt-3 flex items-center gap-3">
              <span className="text-sm text-slate-300">Bot window (seconds)</span>
              <input
                className="w-24 px-3 py-2 rounded-lg bg-slate-900 border border-slate-700 min-h-[40px]"
                type="number" min="1" value={botSec} onChange={e=>setBotSec(e.target.value)}
              />
              <span className="text-sm text-slate-300">Matches: <span id="botCount">{botCount}</span></span>

              <div className="ml-auto flex items-center gap-2">
                <button className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 min-h-[40px]"
                        disabled={currentPage<=1}
                        onClick={()=>setPage(p=>Math.max(1, p-1))}>Prev</button>
                <span className="text-sm text-slate-300">Page {currentPage} / {totalPages}</span>
                <button className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 min-h-[40px]"
                        disabled={currentPage>=totalPages}
                        onClick={()=>setPage(p=>p+1)}>Next</button>
              </div>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="text-slate-400 text-sm mt-8 flex items-center gap-3 flex-wrap pb-safe">
          <span>Categories inferred from receipts, traces, and function names/selectors.</span>
          <span>•</span>
          <span>made by m.sepehri</span>
          <span>•</span>
          <a href="https://discord.com/users/547427240690974730" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-slate-200 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 256 199" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M226 0H30A30 30 0 0 0 0 30v139a30 30 0 0 0 30 30h164l-8-28l19 18l17 16l34 30V30a30 30 0 0 0-30-30Zm-49 129s-5-6-9-11c18-5 25-16 25-16a82 82 0 0 1-16 9a88 88 0 0 1-19 6a100 100 0 0 1-36 0a88 88 0 0 1-19-6a82 82 0 0 1-16-9s7 11 25 16c-4 5-9 11-9 11c-29-1-40-20-40-20c0-43 19-77 19-77c19-14 36-13 36-13l1 1c-23 7-33 18-33 18s3-2 9-5c16-7 28-8 33-8h3c5 0 17 1 33 8c6 3 9 5 9 5s-10-11-33-18l1-1s17-1 36 13c0 0 19 34 19 77c0 0-11 19-40 20Zm-61-35c-7 0-12-6-12-13s5-13 12-13s12 6 12 13s-5 13-12 13Zm47 0c-7 0-12-6-12-13s5-13 12-13s12 6 12 13s-5 13-12 13Z"/></svg>
            <span>Discord</span>
          </a>
          <span>•</span>
          <a href="https://github.com/msepehri55" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-slate-200 hover:text-white">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.33c-2.23.49-2.7-1.07-2.7-1.07c-.36-.91-.88-1.15-.88-1.15c-.72-.5.06-.49.06-.49c.8.06 1.22.82 1.22.82c.71 1.21 1.87.86 2.33.66c.07-.51.28-.86.5-1.06c-1.78-.2-3.64-.89-3.64-3.95c0-.87.31-1.59.82-2.15c-.08-.2-.36-1.01.08-2.11c0 0 .67-.21 2.2.82A7.68 7.68 0 0 1 8 4.84c.68 0 1.37.09 2.01.26c1.53-1.03 2.2-.82 2.2-.82c.44 1.1.16 1.91.08 2.11c.51.56.82 1.27.82 2.15c0 3.07-1.87 3.75-3.65 3.95c.29.25.54.74.54 1.5v2.22c0 .21.15.45.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8"/></svg>
            <span>GitHub</span>
          </a>
        </footer>
      </main>
    </div>
  );
}