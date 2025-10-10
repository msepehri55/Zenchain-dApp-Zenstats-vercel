// lib/shared.js
import { createPublicClient, http, keccak256, toBytes } from 'viem';

// ============ Config ============
const EXPLORER_BASE = 'https://zentrace.io';
const API_BASE = `${EXPLORER_BASE}/api`;
const RPC = 'https://zenchain-testnet.api.onfinality.io/public';

// Caching and performance
const FEED_CACHE_TTL_MS = 25000;
const RECEIPT_CONCURRENCY = 12;
const TX_CONCURRENCY = 10;
const BLOCK_CONCURRENCY = 8;
const RECEIPT_RETRIES = 2;
const TX_RETRIES = 2;

// Hydration to ensure "All Transactions" never misses externals
const ENABLE_HYDRATE_INTERNALS = true;
const ENABLE_HYDRATE_TOKENS = true;
const HYDRATE_INT_LIMIT = 200;
const HYDRATE_TOKEN_LIMIT = 350;

// Receipt scan for unknown outgoing calls (to detect mints/domains)
const MAX_MINTDOMAIN_CANDIDATES = 250;

// Optional allowlist of known domain registrars/controllers
const DOMAIN_CONTRACTS = toLowerSet([
  // '0xabc...'
]);

// ============ Client & caches ============
const client = createPublicClient({ transport: http(RPC) });

const receiptCache = new Map(); // hashLower -> receipt
const txCache = new Map();      // hashLower -> tx
const metaCache = new Map();    // nftContractLower -> { symbol, name }
const metaCacheLock = new Map();
const feedCache = new Map();    // url -> { t, v }
const blockTsCache = new Map(); // blockNumberNumber -> timestampSec

// ============ Utils ============
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
  } finally { clearTimeout(id); }
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

// ============ Range ============
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

// ============ Explorer paging ============
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

// ============ Format ============
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

// ============ Constants ============
const ZERO = '0x0000000000000000000000000000000000000000';
const CCO_TARGET = '0x016ef0f56d7344d0e55f6bc2a20618e02dae8be0'.toLowerCase();

const GM_CONTRACTS = toLowerSet([
  '0xf617d89a811a39f06f5271f89db346a0ae297f71',
  '0x1290b4f2a419a316467b580a088453a233e9adcc',
]);
const CC_CONTRACTS = toLowerSet([
  '0x2f96d7dd813b8e17071188791b78ea3fab5c109c'
]);

// ============ Topics & selectors ============
const sel = (sig) => '0x' + keccak256(toBytes(sig)).slice(2, 10);
const topic = (sig) => keccak256(toBytes(sig));
const addrFromTopic = (t) => (t && t.length >= 66) ? ('0x' + t.slice(26)).toLowerCase() : null;

const TOPIC_ERC721_TRANSFER = topic('Transfer(address,address,uint256)');
const TOPIC_ERC721A_CONSEC  = topic('ConsecutiveTransfer(uint256,uint256,address,address)');
const TOPIC_ERC1155_SINGLE  = topic('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_ERC1155_BATCH   = topic('TransferBatch(address,address,address,uint256[],uint256[])');

const DOMAIN_TOPICS = new Set([
  topic('NameRegistered(bytes32,address,uint256)'),
  topic('NameRegistered(string,address,uint256)'),
  topic('NameRegistered(bytes32,address,uint256,uint256)'),
  topic('NameRegistered(string,address,uint256,uint256)'),
  topic('DomainRegistered(address,string,uint256)'),
  topic('DomainRegistered(address,string,uint256,uint256)'),
  topic('NewOwner(bytes32,bytes32,address)'),
  topic('SubnodeCreated(bytes32,bytes32,address)'),
  // Common custom variants
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

// ============ ERC721 meta ============
const ERC721_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

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

// ============ Helpers ============
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

async function isDomainContract(contractAddr) {
  const a = String(contractAddr || '').toLowerCase();
  if (!a) return false;
  if (DOMAIN_CONTRACTS.has(a)) return true;
  try {
    const meta = await get721Meta(a);
    return looksLikeDomainText(meta?.symbol) || looksLikeDomainText(meta?.name);
  } catch { return false; }
}

// Quick classifiers (no receipts)
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
  // DO NOT match on "mint" here
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

// ============ RPC helpers with caching ============
const limitReceipt = pLimit(RECEIPT_CONCURRENCY);
async function getReceiptsSelective(hashes, retries = RECEIPT_RETRIES) {
  const out = new Map();
  const uniq = [...new Set(hashes || [])];
  await Promise.all(uniq.map(h => limitReceipt(async () => {
    const k = String(h || '').toLowerCase();
    if (!k) return;
    if (receiptCache.has(k)) { out.set(k, receiptCache.get(k)); return; }
    for (let i=0;i<=retries;i++){
      try {
        const rec = await client.getTransactionReceipt({ hash: k });
        receiptCache.set(k, rec);
        out.set(k, rec);
        return;
      } catch { await sleep(120*(i+1)); }
    }
  })));
  return out;
}

const limitTx = pLimit(TX_CONCURRENCY);
async function getTransactionsSelective(hashes, retries = TX_RETRIES) {
  const out = new Map();
  const uniq = [...new Set(hashes || [])];
  await Promise.all(uniq.map(h => limitTx(async () => {
    const k = String(h || '').toLowerCase();
    if (!k) return;
    if (txCache.has(k)) { out.set(k, txCache.get(k)); return; }
    for (let i=0;i<=retries;i++){
      try {
        const tx = await client.getTransaction({ hash: k });
        txCache.set(k, tx);
        out.set(k, tx);
        return;
      } catch { await sleep(120*(i+1)); }
    }
  })));
  return out;
}

const limitBlock = pLimit(BLOCK_CONCURRENCY);
async function getBlockTimestamps(blockNumbers) {
  const out = new Map();
  const uniq = [...new Set(blockNumbers || [])].filter(n => Number(n) > 0);
  await Promise.all(uniq.map(n => limitBlock(async () => {
    const key = Number(n);
    if (blockTsCache.has(key)) { out.set(key, blockTsCache.get(key)); return; }
    try {
      const blk = await client.getBlock({ blockNumber: BigInt(key) });
      const ts = Number(blk?.timestamp ?? 0);
      blockTsCache.set(key, ts);
      out.set(key, ts);
    } catch {
      out.set(key, 0);
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

async function fillMissingTimestamps(externals) {
  const miss = (externals || []).filter(t => !t.timeStamp && Number(t.blockNumber || 0) > 0);
  if (!miss.length) return externals;
  const tsByBlock = await getBlockTimestamps(miss.map(t => Number(t.blockNumber || 0)));
  for (const t of miss) {
    const bn = Number(t.blockNumber || 0);
    const ts = tsByBlock.get(bn) || 0;
    if (ts > 0) t.timeStamp = String(ts);
  }
  return externals;
}

// Kept for compatibility
export async function buildEOAMap() { return new Map(); }
export async function fetchInternalsByTxHash(txhash) {
  const url = buildUrl({ module: 'account', action: 'txlistinternal', txhash });
  const j = await getJSON(url);
  return Array.isArray(j?.result) ? j.result : [];
}

// Hydration (completeness for All Transactions)
async function hydrateMissingExternalsFromInternals({ internalsFeed, externals, address, limit = HYDRATE_INT_LIMIT }) {
  const extSet = new Set((externals || []).map(t => String(t.hash || '').toLowerCase()));
  const intByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (h) intByHash.set(h, it);
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

// ============ Core activity ============
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

  // Hydration (so every external tx appears)
  if (ENABLE_HYDRATE_INTERNALS) {
    externals = await hydrateMissingExternalsFromInternals({ internalsFeed, externals, address: addr });
  }
  if (ENABLE_HYDRATE_TOKENS) {
    externals = await hydrateMissingExternalsFromTokenFeeds({ token20: erc20, token721: erc721, token1155: erc1155, externals });
  }
  // Ensure hydrated rows have timeStamp for correct ordering
  externals = await fillMissingTimestamps(externals);

  // Feed hints (fast)
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

  // Internals map (for contract creation)
  const internalsByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    const arr = internalsByHash.get(h) || [];
    arr.push(it);
    internalsByHash.set(h, arr);
  }

  // First pass
  const nativeRows = [];
  const nativeConfirmSet = new Set();
  const mintDomainCandidates = [];

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
      // Contract creation by user
      const list = internalsByHash.get(txhashLower) || [];
      const hintedCreation = list.some(i => {
        const typ = String(i.type || '').toLowerCase();
        const created = (i.contractAddress || '').toLowerCase();
        return (typ === 'create' || typ === 'create2' || created) && fromLower === addr;
      });
      if (hintedCreation) category = 'cc';

      // Unknown outgoing contract call: candidate for mint/domain scan
      const isOutgoing = fromLower === addr;
      const isContractCall = !!t.to && !isPrecompile(t.to);
      const hasNonEmptyInput = !emptyInput(t.input);
      if (category === 'other' && isOutgoing && isContractCall && (hasNonEmptyInput || DOMAIN_CONTRACTS.has(toLower))) {
        if (mintDomainCandidates.length < MAX_MINTDOMAIN_CANDIDATES) {
          mintDomainCandidates.push(txhashLower);
        }
      }
    }

    const tsNum = Number(t.timeStamp || 0);
    nativeRows.push({
      kind: 'native',
      hash: t.hash,
      blockNumber: Number(t.blockNumber || 0),
      timeMs: (tsNum > 0 ? tsNum : 0) * 1000,
      from: fromLower,
      to: t.to ? toLower : null,
      direction: fromLower === addr ? 'out' : 'in',
      value: formatUnits(t.value || '0', 18),
      valueNorm: Number(formatUnits(t.value || '0', 18)),
      category
    });
  }

  // Confirm native_send + detect mints/domains (receipt-driven)
  const toConfirm = [...new Set([...nativeConfirmSet, ...mintDomainCandidates])];
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

    for (const h of mintDomainCandidates) {
      const rcp = rcpts.get(h);
      const row = rowByHash.get(h);
      const tx  = extByHash.get(h);
      if (!row || !rcp || !tx || isFailed(rcp)) continue;

      // Domain via topics/selectors
      if (isDomainBySigOrEvent(tx, rcp)) {
        row.category = 'domain_mint';
        continue;
      }
      // Mint detection
      const minted = mintedContractsForUser(rcp, addr);
      if (minted.size > 0) {
        // If any minted contract clearly looks like a domain collection, mark as domain
        let isDomain = false;
        for (const c of minted) {
          if (DOMAIN_CONTRACTS.has(c)) { isDomain = true; break; }
          // Fallback meta check (cached)
          // eslint-disable-next-line no-await-in-loop
          if (await isDomainContract(c)) { isDomain = true; break; }
        }
        row.category = isDomain ? 'domain_mint' : 'nft_mint';
      }
    }
  }

  // Visible non-native rows
  const internalRows = (Array.isArray(internalsFeed) ? internalsFeed : []).map(it => ({
    kind: 'internal',
    hash: it.hash || it.transactionHash,
    blockNumber: Number(it.blockNumber || 0),
    timeMs: Number(it.timeStamp || 0) * 1000,
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
      timeMs: Number(e.timeStamp || 0) * 1000,
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
      timeMs: Number(n.timeStamp || 0) * 1000,
      from: (n.from || '').toLowerCase(),
      to: (n.to || '').toLowerCase() || null,
      direction: ((n.from || '').toLowerCase() === addr) ? 'out' : 'in',
      contract: (n.contractAddress || '').toLowerCase() || undefined,
      symbol: n.tokenSymbol || 'NFT',
      tokenId: String(n.tokenID ?? n.tokenId ?? ''),
      valueNorm: 0,
      category: isMintFromFeed ? 'nft_mint' : null
    };
  });

  // Merge + dedupe with your original priorities
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

// ============ Stats (outgoing externals only) ============
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