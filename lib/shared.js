// lib/shared.js
import { createPublicClient, http, keccak256, toBytes } from 'viem';

// -------- Config --------
const EXPLORER_BASE = 'https://zentrace.io';
const API_BASE = `${EXPLORER_BASE}/api`;
const RPC = 'https://zenchain-testnet.api.onfinality.io/public';

// Feed and RPC caches (keep small TTL to help Vercel)
const FEED_CACHE_TTL_MS = 25_000; // cache explorer pages briefly
const RECEIPT_CONCURRENCY = 10;
const RECEIPT_RETRIES = 2;
const TX_CONCURRENCY = 8;
const TX_RETRIES = 2;

// Hydration ON for completeness (bounded + cached) so "All Transactions" never misses externals
const ENABLE_HYDRATE_INTERNALS = true;
const ENABLE_HYDRATE_TOKENS = true;
const HYDRATE_INT_LIMIT = 200;
const HYDRATE_TOKEN_LIMIT = 350;

// Extra receipts scan for unknown outgoing calls to detect NFT/domain mints
const MAX_MINTDOMAIN_CANDIDATES = 220;

// Optional: known domain registrar/controller contracts (fill these if you know them)
const DOMAIN_CONTRACTS = toLowerSet([
  // '0xabc...'
]);

// -------- Client & caches --------
const client = createPublicClient({ transport: http(RPC) });

const receiptCache = new Map(); // txHashLower -> receipt
const txCache = new Map();      // txHashLower -> tx
const metaCache = new Map();    // nftContractLower -> { symbol, name }
const feedCache = new Map();    // url -> { t, v }

// -------- Small utils --------
function buildUrl(params) {
  const u = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
function nowMs() { return Date.now(); }

async function getJSON(url, timeoutMs = 20000, cacheTtl = FEED_CACHE_TTL_MS) {
  const hit = feedCache.get(url);
  const t = nowMs();
  if (hit && (t - hit.t) < cacheTtl) return hit.v;

  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = await r.json();
    feedCache.set(url, { t, v });
    return v;
  } finally {
    clearTimeout(id);
  }
}

const toLowerSet = (arr) => new Set(arr.map(s => String(s || '').toLowerCase()));
const inputSig = (tx) => String(tx?.input ?? tx?.methodId ?? '0x').slice(0, 10).toLowerCase();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = keyFn(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}
function pLimit(n) {
  let active = 0;
  const q = [];
  const runNext = () => { active--; if (q.length) q.shift()(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => {
      active++;
      fn().then(v => { resolve(v); runNext(); }).catch(e => { reject(e); runNext(); });
    };
    if (active < n) run(); else q.push(run);
  });
}

// -------- Range --------
export function parseRange(q) {
  const now = Math.floor(Date.now() / 1000);
  const p = String(q.period || '').toLowerCase();
  if (p === '24h') return { start: now - 24 * 60 * 60, end: now };
  if (p === '7d')  return { start: now - 7  * 24 * 60 * 60, end: now };
  if (p === '30d') return { start: now - 30 * 24 * 60 * 60, end: now };
  if (p === 'all') return { start: 0, end: now };
  const start = q.start ? Math.floor(Number(q.start)) : now - 7 * 24 * 60 * 60;
  const end = q.end ? Math.floor(Number(q.end)) : now;
  return { start, end };
}

// -------- Explorer paging --------
export async function fetchPagedAccount(action, address, { startTs, endTs }, opts = {}) {
  let pageSize = opts.pageSize ?? 100;
  let maxPages = opts.maxPages ?? 20;
  const absMaxPages = opts.absMaxPages ?? 300;
  const dynamic = opts.dynamic !== false;
  if (startTs === 0) maxPages = Math.max(maxPages, 250);

  const out = [];
  let page = 1;
  while (true) {
    if (page > maxPages) {
      if (dynamic && maxPages < absMaxPages) maxPages = Math.min(absMaxPages, maxPages + 20);
      else break;
    }
    const url = buildUrl({ module: 'account', action, address, page, offset: pageSize, sort: 'desc' });
    let j;
    try { j = await getJSON(url); } catch { break; }
    const arr = Array.isArray(j?.result) ? j.result : [];
    if (!arr.length) break;
    out.push(...arr);

    const oldestOnPage = Math.min(...arr.map(x => Number(x.timeStamp || 0)));
    if (oldestOnPage <= startTs || arr.length < pageSize) break;

    page += 1;
  }
  const filtered = out.filter(x => {
    const ts = Number(x.timeStamp || 0);
    return ts >= startTs && ts <= endTs;
  });
  return uniqueBy(filtered, x => String(x.hash || x.transactionHash || '').toLowerCase());
}

// -------- Format --------
export function formatUnits(raw, decimals) {
  try {
    const d = BigInt(decimals);
    let x = BigInt(raw || '0');
    const base = 10n ** d;
    const neg = x < 0n;
    if (neg) x = -x;
    const int = x / base;
    let frac = (x % base).toString().padStart(Number(d), '0').replace(/0+$/g, '');
    const s = frac.length ? `${int}.${frac}` : `${int}`;
    return neg ? `-${s}` : s;
  } catch { return '0'; }
}

// -------- Constants --------
const ZERO = '0x0000000000000000000000000000000000000000';
const CCO_TARGET = '0x016ef0f56d7344d0e55f6bc2a20618e02dae8be0'.toLowerCase();

// Known contracts
const GM_CONTRACTS = toLowerSet([
  '0xf617d89a811a39f06f5271f89db346a0ae297f71',
  '0x1290b4f2a419a316467b580a088453a233e9adcc',
]);
const CC_CONTRACTS = toLowerSet([
  '0x2f96d7dd813b8e17071188791b78ea3fab5c109c'
]);

// -------- Topics/selectors --------
const sel = (sig) => '0x' + keccak256(toBytes(sig)).slice(2, 10);
const topic = (sig) => keccak256(toBytes(sig));
const addrFromTopic = (t) => (t && t.length >= 66) ? ('0x' + t.slice(26)).toLowerCase() : null;

// ERC-721/1155
const TOPIC_ERC721_TRANSFER = topic('Transfer(address,address,uint256)');
const TOPIC_ERC721A_CONSEC  = topic('ConsecutiveTransfer(uint256,uint256,address,address)');
const TOPIC_ERC1155_SINGLE  = topic('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_ERC1155_BATCH   = topic('TransferBatch(address,address,address,uint256[],uint256[])');

// Domain topics/selectors (common)
const DOMAIN_TOPICS = new Set([
  topic('NameRegistered(bytes32,address,uint256)'),
  topic('NameRegistered(string,address,uint256)'),
  topic('NameRegistered(bytes32,address,uint256,uint256)'),
  topic('NameRegistered(string,address,uint256,uint256)'),
  topic('DomainRegistered(address,string,uint256)'),
  topic('DomainRegistered(address,string,uint256,uint256)'),
  topic('NewOwner(bytes32,bytes32,address)'),
  topic('SubnodeCreated(bytes32,bytes32,address)'),
  // Extras (cover more custom registrars)
  topic('Register(address,string,uint256)'),
  topic('Registered(address,string,uint256)'),
  topic('NameClaimed(address,string)'),
]);

const DOMAIN_SELECTORS = new Set([
  sel('registerDomains(string[],address,uint256)'),
  sel('registerDomains(string[],address)'),
  sel('registerDomain(string,address,uint256)'),
  sel('registerDomain(string,address)'),
  sel('register(string,address,uint256)'),
  sel('register(bytes32,address,uint256)'),
  sel('registerWithConfig(string,address,uint256,address,address)'),
  sel('registerWithConfig(bytes32,address,uint256,address,address)'),
  sel('registerName(string,address,uint256)'),
  sel('claim(string)'),
  sel('claim(bytes32)'),
  sel('commit(bytes32)'),
]);

const GM_SELECTORS = new Set([ sel('sayGM()'), sel('gm()'), '0x84a3bb6b' ]);

const STAKE_SELECTORS = new Set([
  sel('stake(uint256)'), sel('stake(uint256,address)'),
  sel('deposit(uint256)'), sel('deposit(uint256,address)'), sel('deposit()'),
  sel('delegate(address,uint256)'), sel('delegate(uint256)'),
  sel('bond(uint256)'), sel('bondExtra(uint256)'), sel('bondExtra()'), sel('bondMore(uint256)'),
  sel('nominate(address[])'), sel('unbond(uint256)'),
  sel('withdrawUnbonded(uint32)'), sel('restake(uint256)'), sel('redelegate(address,uint256)'),
]);

const SWAP_SELECTORS = new Set([
  // V2
  sel('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapTokensForExactTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapExactETHForTokens(uint256,address[],address,uint256)'),
  sel('swapETHForExactTokens(uint256,address[],address,uint256)'),
  sel('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'),
  sel('swapTokensForExactETH(uint256,uint256,address[],address,uint256)'),
  sel('swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)'),
  sel('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'),
  // V3
  sel('exactInput(bytes)'),
  sel('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'),
  sel('exactOutput(bytes)'),
  sel('exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'),
]);

const ADD_LIQ_SELECTORS = new Set([
  sel('addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)'),
  sel('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)'),
]);
const REM_LIQ_SELECTORS = new Set([
  sel('removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)'),
  sel('removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)'),
  sel('removeLiquidityWithPermit(address,address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)'),
  sel('removeLiquidityETHWithPermit(address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)'),
  sel('removeLiquidityETHSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256)'),
  sel('removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(address,uint256,uint256,uint256,address,uint256,bool,uint8,bytes32,bytes32)'),
]);

const APPROVE_SELECTORS = new Set([
  sel('approve(address,uint256)'),
  sel('increaseAllowance(address,uint256)'),
  sel('decreaseAllowance(address,uint256)'),
  sel('setApprovalForAll(address,bool)'),
]);

// NFT mint-ish
const NFT_MINT_SELECTORS = new Set([
  sel('mint()'),
  sel('mint(uint256)'),
  sel('mint(address)'),
  sel('mint(address,uint256)'),
  sel('mintTo(address,uint256)'),
  sel('safeMint(address)'),
  sel('safeMint(address,uint256)'),
  sel('publicMint(uint256)'),
  sel('batchMint(address,uint256)'),
  sel('batchMint(address,uint256[])'),
  sel('claim()'),
  sel('claim(uint256)'),
  sel('claim(address,uint256)'),
]);

// -------- ERC-721 meta (not on hot path) --------
const ERC721_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

const metaCacheLock = new Map();
export async function get721Meta(address) {
  const addr = String(address || '').toLowerCase();
  if (metaCache.has(addr)) return metaCache.get(addr);
  if (metaCacheLock.has(addr)) return metaCacheLock.get(addr);
  const p = (async () => {
    let symbol = '', name = '';
    try { symbol = await client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'symbol' }); } catch {}
    try { name   = await client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'name'   }); } catch {}
    const meta = { symbol: String(symbol || ''), name: String(name || '') };
    metaCache.set(addr, meta);
    metaCacheLock.delete(addr);
    return meta;
  })();
  metaCacheLock.set(addr, p);
  return p;
}

// -------- Helpers --------
const emptyInput = (d) => /^0x0*$/i.test(d || '0x');
const isPrecompile = (to) => (to || '').toLowerCase().startsWith('0x0000000000000000000000000000000000000');

function isFailed(rcpt) {
  const s = rcpt?.status;
  return s === 'reverted' || s === 0 || s === 0n || s === '0' || s === '0x0';
}
function isFailedByTxlist(t) {
  const e = String(t?.isError ?? '').toLowerCase();
  const s = String(t?.txreceipt_status ?? t?.status ?? '').toLowerCase();
  return e === '1' || s === '0' || s === '0x0' || s === 'reverted';
}

function isNativeSendCandidate(tx, user) {
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  const val = BigInt(tx.value || '0');
  if (from !== user) return false;
  if (!to) return false;
  if (isPrecompile(to)) return false;
  if (val <= 0n) return false;
  if (!emptyInput(tx.input)) return false;
  return true;
}

const looksLikeDomainText = (s) => {
  if (!s) return false;
  const x = String(s).toLowerCase();
  if (x.includes('.ztc') || x.includes('.zen')) return true;
  if (/\b(zns|ens)\b/.test(x)) return true;
  if (/\b(name service|domain service|domain registrar|registry|name registry)\b/.test(x)) return true;
  return false;
};

function isDomainBySigOrEvent(tx, rcpt) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('register') || fn.includes('domain') || fn.includes('name') || fn.includes('zns'))) return true;
  if (DOMAIN_SELECTORS.has(sig)) return true;
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (DOMAIN_TOPICS.has(t0)) return true;
  }
  return false;
}

// 721A decoder (addresses may be in topics)
function parse721AAddresses(lg) {
  try {
    const t = (lg.topics || []).map(x => String(x || '').toLowerCase());
    if (t.length >= 4) {
      const fromT = addrFromTopic(t[2]);
      const toT   = addrFromTopic(t[3]);
      if (fromT && toT) return { from: fromT, to: toT };
    }
  } catch {}
  return null;
}

function mintedContractsForUser(rcpt, user) {
  const set = new Set();
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (t0 === TOPIC_ERC721_TRANSFER.toLowerCase()) {
      const from = addrFromTopic(lg.topics?.[1] || '');
      const to   = addrFromTopic(lg.topics?.[2] || '');
      if (from === ZERO.toLowerCase() && to === user) set.add(String(lg.address || '').toLowerCase());
    } else if (t0 === TOPIC_ERC721A_CONSEC.toLowerCase()) {
      const pair = parse721AAddresses(lg);
      if (pair && pair.from === ZERO.toLowerCase() && pair.to === user) set.add(String(lg.address || '').toLowerCase());
    } else if (t0 === TOPIC_ERC1155_SINGLE.toLowerCase() || t0 === TOPIC_ERC1155_BATCH.toLowerCase()) {
      const from = addrFromTopic(lg.topics?.[2] || '');
      const to   = addrFromTopic(lg.topics?.[3] || '');
      if (from === ZERO.toLowerCase() && to === user) set.add(String(lg.address || '').toLowerCase());
    }
  }
  return set;
}

// Quick classifiers
function isStakeQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('bond') || fn.includes('stake') || fn.includes('delegate') ||
             fn.includes('nominate') || fn.includes('unbond') ||
             fn.includes('withdraw') || fn.includes('restake') || fn.includes('redelegate')))
    return true;
  return STAKE_SELECTORS.has(sig);
}
function isGMQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('saygm') || fn === 'gm')) return true;
  return GM_SELECTORS.has(sig);
}
function isSwapQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn.includes('swap') || fn.includes('exactinput') || fn.includes('exactoutput')) return true;
  return SWAP_SELECTORS.has(sig);
}
function isAddLiquidityQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  // Do NOT match on "mint" here (prevents NFT mint mislabels)
  if (fn.includes('addliquidity') || fn.includes('addliquidityeth')) return true;
  return ADD_LIQ_SELECTORS.has(sig);
}
function isRemoveLiquidityQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn.includes('removeliquidity') || fn.includes('decreaseliquidity')) return true;
  return REM_LIQ_SELECTORS.has(sig);
}
function isApproveQuick(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn === 'approve' || fn.includes('allowance') || fn.includes('approval')) return true;
  return APPROVE_SELECTORS.has(sig);
}
function isCCO(tx) {
  const to = (tx.to || '').toLowerCase();
  return to === CCO_TARGET;
}

// -------- RPC helpers (cached) --------
const limitReceipt = pLimit(RECEIPT_CONCURRENCY);
async function getReceiptsSelective(hashes, retries = RECEIPT_RETRIES) {
  const out = new Map();
  await Promise.all([...(new Set(hashes || []))].map(h => limitReceipt(async () => {
    const k = String(h || '').toLowerCase();
    if (!k) return;
    if (receiptCache.has(k)) { out.set(k, receiptCache.get(k)); return; }
    for (let i = 0; i <= retries; i++) {
      try {
        const rec = await client.getTransactionReceipt({ hash: k });
        receiptCache.set(k, rec);
        out.set(k, rec);
        return;
      } catch { await sleep(120 * (i + 1)); }
    }
  })));
  return out;
}
const limitTx = pLimit(TX_CONCURRENCY);
async function getTransactionsSelective(hashes, retries = TX_RETRIES) {
  const out = new Map();
  await Promise.all([...(new Set(hashes || []))].map(h => limitTx(async () => {
    const k = String(h || '').toLowerCase();
    if (!k) return;
    if (txCache.has(k)) { out.set(k, txCache.get(k)); return; }
    for (let i = 0; i <= retries; i++) {
      try {
        const tx = await client.getTransaction({ hash: k });
        txCache.set(k, tx);
        out.set(k, tx);
        return;
      } catch { await sleep(120 * (i + 1)); }
    }
  })));
  return out;
}

export async function fillMissingInputs(externals) {
  const missing = (externals || []).filter(t => !t.input);
  if (!missing.length) return externals;
  const map = await getTransactionsSelective(missing.map(m => m.hash));
  for (const t of externals) {
    if (!t.input) {
      const tx = map.get(String(t.hash || '').toLowerCase());
      if (tx?.input) t.input = tx.input;
    }
  }
  return externals;
}

// -------- Optional helpers kept for compat --------
export async function buildEOAMap() { return new Map(); }
export async function fetchInternalsByTxHash(txhash) {
  const url = buildUrl({ module: 'account', action: 'txlistinternal', txhash });
  const j = await getJSON(url);
  return Array.isArray(j?.result) ? j.result : [];
}

// Hydrate externals from internals feed (completeness)
async function hydrateMissingExternalsFromInternals({ internalsFeed, externals, address, limit = HYDRATE_INT_LIMIT }) {
  const extSet = new Set((externals || []).map(t => String(t.hash || '').toLowerCase()));
  const intByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    intByHash.set(h, it);
  }
  const missing = [...intByHash.keys()].filter(h => !extSet.has(h)).slice(0, limit);
  if (!missing.length) return externals;

  const txs = await getTransactionsSelective(missing);
  const merged = [];
  for (const h of missing) {
    const tx = txs.get(h);
    if (!tx) continue;
    const it = intByHash.get(h);
    const ts = Number(it?.timeStamp || 0);
    merged.push({
      hash: h,
      blockNumber: Number(tx.blockNumber || 0),
      timeStamp: ts ? String(ts) : undefined,
      from: String(tx.from || '').toLowerCase(),
      to: tx.to ? String(tx.to).toLowerCase() : null,
      value: (typeof tx.value === 'bigint') ? tx.value.toString() : String(tx.value || '0'),
      input: tx.input || '0x',
      functionName: ''
    });
  }
  return [...externals, ...merged];
}

// Hydrate externals from token feeds (completeness)
async function hydrateMissingExternalsFromTokenFeeds({ token20, token721, token1155, externals, limit = HYDRATE_TOKEN_LIMIT }) {
  const extSet = new Set((externals || []).map(t => String(t.hash || '').toLowerCase()));
  const tsMap = new Map();
  for (const e of token20 || []) {
    const h = String(e.hash || e.transactionHash || '').toLowerCase();
    if (h && !extSet.has(h)) tsMap.set(h, Number(e.timeStamp || 0));
  }
  for (const n of token721 || []) {
    const h = String(n.hash || n.transactionHash || '').toLowerCase();
    if (h && !extSet.has(h)) {
      const t = Number(n.timeStamp || 0);
      if (!tsMap.has(h) || t < tsMap.get(h)) tsMap.set(h, t);
    }
  }
  for (const m of token1155 || []) {
    const h = String(m.hash || m.transactionHash || '').toLowerCase();
    if (h && !extSet.has(h)) {
      const t = Number(m.timeStamp || 0);
      if (!tsMap.has(h) || t < tsMap.get(h)) tsMap.set(h, t);
    }
  }
  const missing = [...tsMap.keys()].slice(0, limit);
  if (!missing.length) return externals;

  const txs = await getTransactionsSelective(missing);
  const merged = [];
  for (const h of missing) {
    const tx = txs.get(h);
    if (!tx) continue;
    const ts = tsMap.get(h) || 0;
    merged.push({
      hash: h,
      blockNumber: Number(tx.blockNumber || 0),
      timeStamp: ts ? String(ts) : undefined,
      from: String(tx.from || '').toLowerCase(),
      to: tx.to ? String(tx.to).toLowerCase() : null,
      value: (typeof tx.value === 'bigint') ? tx.value.toString() : String(tx.value || '0'),
      input: tx.input || '0x',
      functionName: ''
    });
  }
  return [...externals, ...merged];
}

// -------- Core: build activity --------
export async function buildActivity({ address, start, end }) {
  const addr = address.toLowerCase();

  // Fetch feeds in parallel
  const [externalsRaw, internalsFeed, erc20, erc721, erc1155] = await Promise.all([
    fetchPagedAccount('txlist',        addr, { startTs: start, endTs: end }),
    fetchPagedAccount('txlistinternal',addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokentx',       addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokennfttx',    addr, { startTs: start, endTs: end }),
    fetchPagedAccount('token1155tx',   addr, { startTs: start, endTs: end }).catch(() => []),
  ]);
  let externals = externalsRaw;

  // Hydrate missing externals (bounded) so every tx shows
  if (ENABLE_HYDRATE_INTERNALS) {
    externals = await hydrateMissingExternalsFromInternals({ internalsFeed, externals, address: addr });
  }
  if (ENABLE_HYDRATE_TOKENS) {
    externals = await hydrateMissingExternalsFromTokenFeeds({ token20: erc20, token721: erc721, token1155: erc1155, externals });
  }

  // Feed hints for mints (fast)
  const domainTxFromFeed = new Set(
    (Array.isArray(erc721) ? erc721 : [])
      .filter(n => String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr)
      .filter(n => looksLikeDomainText(n.tokenSymbol) || looksLikeDomainText(n.tokenName))
      .map(n => String(n.hash || n.transactionHash || '').toLowerCase())
  );
  const nftMintFromFeed = new Set([
    ...((Array.isArray(erc721) ? erc721 : [])
      .filter(n => String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr)
      .map(n => String(n.hash || n.transactionHash || '').toLowerCase())),
    ...((Array.isArray(erc1155) ? erc1155 : [])
      .filter(m => String(m.from || '').toLowerCase() === ZERO.toLowerCase() && String(m.to || '').toLowerCase() === addr)
      .map(m => String(m.hash || m.transactionHash || '').toLowerCase())),
  ]);

  // Internals by hash (for contract creation)
  const internalsByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    const arr = internalsByHash.get(h) || [];
    arr.push(it);
    internalsByHash.set(h, arr);
  }

  // First pass (no receipts)
  const nativeRows = [];
  const nativeConfirmSet = new Set();
  const candidateList = []; // ordered list to cap mint/domain receipt scanning

  for (const t of externals || []) {
    const toLower = (t.to || '').toLowerCase();
    const fromLower = (t.from || '').toLowerCase();
    const txhashLower = String(t.hash || '').toLowerCase();

    let category = 'other';

    if (isFailedByTxlist(t)) {
      category = 'fail';
    } else if (CC_CONTRACTS.has(toLower)) {
      category = 'cc';
    } else if (isCCO(t)) {
      category = 'cco';
    } else if (GM_CONTRACTS.has(toLower)) {
      category = 'gm';
    } else if (domainTxFromFeed.has(txhashLower)) {
      category = 'domain_mint';
    } else if (nftMintFromFeed.has(txhashLower)) {
      category = 'nft_mint';
    } else if (isStakeQuick(t)) {
      category = 'stake';
    } else if (isSwapQuick(t)) {
      category = 'swap';
    } else if (isAddLiquidityQuick(t)) {
      category = 'add_liquidity';
    } else if (isRemoveLiquidityQuick(t)) {
      category = 'remove_liquidity';
    } else if (isGMQuick(t)) {
      category = 'gm';
    } else if (isApproveQuick(t)) {
      category = 'approve';
    } else if (isNativeSendCandidate(t, addr)) {
      nativeConfirmSet.add(txhashLower);
    } else {
      // Contract creation by user via internals
      const list = internalsByHash.get(txhashLower) || [];
      const hintedCreation = list.some(i => {
        const typ = String(i.type || '').toLowerCase();
        const created = (i.contractAddress || '').toLowerCase();
        return (typ === 'create' || typ === 'create2' || created) && fromLower === addr;
      });
      if (hintedCreation) category = 'cc';

      // Build candidate list for receipt scan to detect mint/domain (bounded)
      const outgoing = fromLower === addr;
      const contractCall = !!t.to && !isPrecompile(t.to);
      const hasNonEmptyInput = !emptyInput(t.input);
      if (outgoing && contractCall && category === 'other' && (hasNonEmptyInput || DOMAIN_CONTRACTS.has(toLower))) {
        candidateList.push(txhashLower);
      }
    }

    nativeRows.push({
      kind: 'native',
      hash: t.hash,
      blockNumber: Number(t.blockNumber || 0),
      timeMs: Number(t.timeStamp) * 1000,
      from: fromLower,
      to: t.to ? toLower : null,
      direction: fromLower === addr ? 'out' : 'in',
      value: formatUnits(t.value || '0', 18),
      valueNorm: Number(formatUnits(t.value || '0', 18)),
      category
    });
  }

  // Receipt pass: confirm native_send and detect mint/domain for candidates (bounded)
  const candLimited = candidateList.slice(0, MAX_MINTDOMAIN_CANDIDATES);
  const toConfirm = [...new Set([...nativeConfirmSet, ...candLimited])];
  if (toConfirm.length) {
    const rcpts = await getReceiptsSelective(toConfirm);
    const rowByHash = new Map(nativeRows.map(r => [String(r.hash || '').toLowerCase(), r]));
    const extByHash = new Map((externals || []).map(t => [String(t.hash || '').toLowerCase(), t]));

    for (const h of nativeConfirmSet) {
      const rcp = rcpts.get(h);
      const row = rowByHash.get(h);
      if (!row || !rcp) continue;
      if (!isFailed(rcp) && (!rcp.logs || rcp.logs.length === 0)) row.category = 'native_send';
    }

    for (const h of candLimited) {
      const rcp = rcpts.get(h);
      const row = rowByHash.get(h);
      const tx  = extByHash.get(h);
      if (!row || !rcp || !tx || isFailed(rcp)) continue;

      // Domain via topics/selectors
      if (isDomainBySigOrEvent(tx, rcp)) {
        row.category = 'domain_mint';
        continue;
      }
      // Domain fallback: known registrar + register-ish selector/name
      const toAddr = (tx.to || '').toLowerCase();
      const fn = String(tx.functionName || '').toLowerCase();
      const sig = inputSig(tx);
      const looksRegister =
        fn.includes('register') || fn.includes('registername') || fn.includes('registerdomain') ||
        DOMAIN_SELECTORS.has(sig);
      if (DOMAIN_CONTRACTS.has(toAddr) && looksRegister) {
        row.category = 'domain_mint';
        continue;
      }

      // NFT mint via ERC-721/721A/1155 logs to user
      const minted = mintedContractsForUser(rcp, addr);
      if (minted.size > 0) row.category = 'nft_mint';
    }
  }

  // Token + internals (visible, but dedup keeps one row per tx hash)
  const internalRows = (Array.isArray(internalsFeed) ? internalsFeed : []).map(it => ({
    kind: 'internal',
    hash: it.hash || it.transactionHash,
    blockNumber: Number(it.blockNumber || 0),
    timeMs: Number(it.timeStamp) * 1000,
    from: (it.from || '').toLowerCase(),
    to: (it.to || '').toLowerCase() || null,
    direction: ((it.from || '').toLowerCase() === addr) ? 'out' : 'in',
    value: formatUnits(it.value || '0', 18),
    valueNorm: Number(formatUnits(it.value || '0', 18)),
    category: null
  }));

  const token20 = (Array.isArray(erc20) ? erc20 : []).map(e => {
    const dec = Number(e.tokenDecimal || 18);
    const amt = formatUnits(e.value || '0', dec);
    return {
      kind: 'token',
      standard: 'erc20',
      hash: e.hash || e.transactionHash,
      blockNumber: Number(e.blockNumber || 0),
      timeMs: Number(e.timeStamp) * 1000,
      from: (e.from || '').toLowerCase(),
      to: (e.to || '').toLowerCase() || null,
      direction: ((e.from || '').toLowerCase() === addr) ? 'out' : 'in',
      contract: (e.contractAddress || '').toLowerCase() || undefined,
      symbol: e.tokenSymbol || 'TOKEN',
      amount: amt,
      valueNorm: Number(amt),
      category: null
    };
  });

  const token721 = (Array.isArray(erc721) ? erc721 : []).map(n => {
    const isMintFromFeed = (String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr);
    return {
      kind: 'token',
      standard: 'erc721',
      hash: n.hash || n.transactionHash,
      blockNumber: Number(n.blockNumber || 0),
      timeMs: Number(n.timeStamp) * 1000,
      from: (n.from || '').toLowerCase(),
      to: (n.to || '').toLowerCase() || null,
      contract: (n.contractAddress || '').toLowerCase() || undefined,
      symbol: n.tokenSymbol || 'NFT',
      tokenId: String(n.tokenID ?? n.tokenId ?? ''),
      direction: ((n.from || '').toLowerCase() === addr) ? 'out' : 'in',
      valueNorm: 0,
      category: isMintFromFeed ? 'nft_mint' : null
    };
  });

  // Merge + dedupe with your original priorities (keep behavior stable)
  const all = [...nativeRows, ...internalRows, ...token20, ...token721];
  const prio = (r) => {
    if (r.kind === 'native') {
      const c = r.category;
      if (c === 'fail')             return 125;
      if (c === 'domain_mint')      return 120;
      if (c === 'cc')               return 115;
      if (c === 'cco')              return 112;
      if (c === 'stake')            return 105;
      if (c === 'swap')             return 104;
      if (c === 'add_liquidity')    return 103;
      if (c === 'remove_liquidity') return 103;
      if (c === 'gm')               return 100;
      if (c === 'native_send')      return 95;
      if (c === 'approve')          return 93;
      if (c === 'nft_mint')         return 90;
      if (c === 'other')            return 80;
      return 50;
    }
    if (r.kind === 'token') return (r.category === 'nft_mint') ? 85 : 20;
    if (r.kind === 'internal') return 10;
    return 0;
  };
  const best = new Map();
  for (const r of all) {
    const h = String(r.hash || '').toLowerCase();
    if (!h) continue;
    const cur = best.get(h);
    if (!cur || prio(r) > prio(cur)) best.set(h, r);
  }
  const activity = [...best.values()].sort((a, b) => b.timeMs - a.timeMs);
  return activity;
}

// -------- Stats (outgoing externals only) --------
export async function buildStats({ address, start, end }) {
  const activity = await buildActivity({ address, start, end });
  const extOut = activity.filter(r => r.kind === 'native' && r.direction === 'out' && r.category !== 'fail');

  const countCat = (name) => extOut.filter(r => r.category === name).length;
  const ccBoth = extOut.filter(r => r.category === 'cc' || r.category === 'cco').length;

  return {
    stakeActions:          countCat('stake'),
    nativeSends:           countCat('native_send'),
    nftMints:              countCat('nft_mint'),
    domainMints:           countCat('domain_mint'),
    gmCount:               countCat('gm'),
    ccCount:               ccBoth,
    swapCount:             countCat('swap'),
    addLiquidityCount:     countCat('add_liquidity'),
    removeLiquidityCount:  countCat('remove_liquidity'),
    approveCount:          countCat('approve'),
    bridged: 'coming_soon'
  };
}