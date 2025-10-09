// lib/shared.js
import {
  createPublicClient,
  http,
  keccak256,
  toBytes
} from 'viem';

// Explorer + RPC
const EXPLORER_BASE = 'https://zentrace.io';
const API_BASE = `${EXPLORER_BASE}/api`;
const RPC = 'https://zenchain-testnet.api.onfinality.io/public';

// viem client
const client = createPublicClient({ transport: http(RPC) });

// Caches
const receiptCache = new Map(); // txHashLower -> receipt
const codeCache    = new Map(); // addressLower -> bytecode or '0x'
const metaCache    = new Map(); // nftContractLower -> { symbol, name }

// Helpers
function buildUrl(params) {
  const u = new URL(API_BASE);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}
async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
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

// Range parsing
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

// Explorer paging (dynamic expansion to cover older windows with many tx)
export async function fetchPagedAccount(action, address, { startTs, endTs }, opts = {}) {
  let pageSize = opts.pageSize ?? 100;
  let maxPages = opts.maxPages ?? 20;     // starting budget
  const absMaxPages = opts.absMaxPages ?? 300; // hard cap
  const dynamic = opts.dynamic !== false; // default true
  if (startTs === 0) maxPages = Math.max(maxPages, 250);

  const out = [];
  let page = 1;
  while (true) {
    if (page > maxPages) {
      if (dynamic && maxPages < absMaxPages) {
        maxPages = Math.min(absMaxPages, maxPages + 20);
      } else {
        break;
      }
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

// Formatting
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

// Constants
const ZERO = '0x0000000000000000000000000000000000000000';
const CCO_TARGET = '0x016ef0f56d7344d0e55f6bc2a20618e02dae8be0'.toLowerCase();

// Overrides (lowercased)
const GM_CONTRACTS = toLowerSet([
  '0xf617d89a811a39f06f5271f89db346a0ae297f71', // GM (existing)
  '0x1290b4f2a419a316467b580a088453a233e9adcc', // GM (zkCodes)
]);
const CC_CONTRACTS = toLowerSet([
  '0x2f96d7dd813b8e17071188791b78ea3fab5c109c'
]);

// Selectors/topics
const sel = (sig) => '0x' + keccak256(toBytes(sig)).slice(2, 10);
const topic = (sig) => keccak256(toBytes(sig));
const addrFromTopic = (t) => (t && t.length >= 66) ? ('0x' + t.slice(26)).toLowerCase() : null;

const TOPIC_ERC721_TRANSFER = topic('Transfer(address,address,uint256)');
const TOPIC_ERC1155_SINGLE  = topic('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_ERC1155_BATCH   = topic('TransferBatch(address,address,address,uint256[],uint256[])');

const TOPIC_ERC20_APPROVAL       = topic('Approval(address,address,uint256)');
const TOPIC_ERC721_APPROVAL      = topic('Approval(address,address,uint256)');
const TOPIC_ERC1155_APPROVAL_ALL = topic('ApprovalForAll(address,address,bool)');

// Uniswap-like topics (V2/V3)
const TOPIC_UNIV2_SWAP = topic('Swap(address,uint256,uint256,uint256,uint256,address)');
const TOPIC_UNIV2_MINT = topic('Mint(address,uint256,uint256)');
const TOPIC_UNIV2_BURN = topic('Burn(address,uint256,uint256,address)');
const TOPIC_UNIV3_SWAP = topic('Swap(address,address,int256,int256,uint160,uint128,int24)');
const TOPIC_UNIV3_MINT         = topic('Mint(address,uint256,int24,int24,uint128,uint256,uint256)');
const TOPIC_UNIV3_INCREASE_LIQ = topic('IncreaseLiquidity(uint256,uint128,uint256,uint256)');
const TOPIC_UNIV3_DECREASE_LIQ = topic('DecreaseLiquidity(uint256,uint128,uint256,uint256)');

const DOMAIN_TOPICS = new Set([
  topic('NameRegistered(bytes32,address,uint256)'),
  topic('NameRegistered(string,address,uint256)'),
  topic('NameRegistered(bytes32,address,uint256,uint256)'),
  topic('NameRegistered(string,address,uint256,uint256)'),
  topic('DomainRegistered(address,string,uint256)'),
  topic('DomainRegistered(address,string,uint256,uint256)'),
  topic('NewOwner(bytes32,bytes32,address)'),
  topic('SubnodeCreated(bytes32,bytes32,address)')
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
  sel('registerName(string,address,uint256)')
]);

const GM_SELECTORS = new Set([ sel('sayGM()'), sel('gm()'), '0x84a3bb6b' ]);

const STAKE_SELECTORS = new Set([
  sel('stake(uint256)'), sel('stake(uint256,address)'),
  sel('deposit(uint256)'), sel('deposit(uint256,address)'), sel('deposit()'),
  sel('delegate(address,uint256)'), sel('delegate(uint256)'),
  sel('bond(uint256)'), sel('bondExtra(uint256)'), sel('bondExtra()'), sel('bondMore(uint256)'),
  sel('nominate(address[])'), sel('unbond(uint256)'),
  sel('withdrawUnbonded(uint32)'), sel('restake(uint256)'), sel('redelegate(address,uint256)')
]);
const STAKE_TOPICS = new Set([
  topic('Staked(address,uint256)'), topic('Stake(address,uint256)'), topic('Stake(address,uint256,uint256)'),
  topic('Deposit(address,uint256)'), topic('Deposited(address,uint256)'),
  topic('Delegated(address,address,uint256)'), topic('Delegated(address,uint256)'),
  topic('Bonded(address,uint256)'), topic('Unbonded(address,uint256)'), topic('Withdrawn(address,uint256)')
]);

// DEX-related selectors
const SWAP_SELECTORS = new Set([
  // Uniswap V2
  sel('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapTokensForExactTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapExactETHForTokens(uint256,address[],address,uint256)'),
  sel('swapETHForExactTokens(uint256,address[],address,uint256)'),
  sel('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'),
  sel('swapTokensForExactETH(uint256,uint256,address[],address,uint256)'),
  sel('swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'),
  sel('swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)'),
  sel('swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)'),
  // Uniswap V3
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
  sel('approve(address,uint256)'),
]);

// NFT mint selectors (721/721A/1155 common names)
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

// ERC-721 meta
const ERC721_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }
];

// RPC helpers with retries
async function getReceiptsCached(hashes, max = 2500, concurrency = 8, retries = 2) {
  const out = [];
  const miss = [];
  for (const h of hashes) {
    const k = String(h || '').toLowerCase();
    if (!k) continue;
    if (receiptCache.has(k)) out.push(receiptCache.get(k));
    else miss.push(k);
  }
  const take = miss.slice(0, max);
  const limit = pLimit(concurrency);
  await Promise.all(take.map(k => limit(async () => {
    for (let i = 0; i <= retries; i++) {
      try {
        const rec = await client.getTransactionReceipt({ hash: k });
        receiptCache.set(k, rec);
        out.push(rec);
        return;
      } catch {
        await sleep(150 * (i + 1));
      }
    }
  })));
  return out;
}
export async function fillMissingInputs(externals, concurrency = 8, retries = 2) {
  const missing = (externals || []).filter(t => !t.input);
  if (!missing.length) return externals;
  const limit = pLimit(concurrency);
  const map = new Map();
  await Promise.all(missing.map(t => limit(async () => {
    const h = String(t.hash || '').toLowerCase();
    if (!h) return;
    for (let i = 0; i <= retries; i++) {
      try {
        const tx = await client.getTransaction({ hash: h });
        if (tx?.input) map.set(h, tx);
        return;
      } catch { await sleep(120 * (i + 1)); }
    }
  })));
  for (const t of externals) {
    if (!t.input) {
      const tx = map.get(String(t.hash || '').toLowerCase());
      if (tx?.input) t.input = tx.input;
    }
  }
  return externals;
}
export async function buildEOAMap(address, externals) {
  const targets = new Set();
  for (const t of externals || []) {
    const from = (t.from || '').toLowerCase();
    const to = (t.to || '').toLowerCase();
    const val = BigInt(t.value || '0');
    if (from === address && to && val > 0n) targets.add(to);
  }
  const list = [...targets];
  const map = new Map();
  const limit = pLimit(12);
  await Promise.all(list.map(a => limit(async () => {
    const k = String(a || '').toLowerCase();
    if (!k) return map.set(k, true);
    if (codeCache.has(k)) return map.set(k, !codeCache.get(k) || codeCache.get(k) === '0x');
    try {
      const code = await client.getBytecode({ address: k });
      codeCache.set(k, code || '0x');
      map.set(k, !code || code === '0x');
    } catch { map.set(k, true); }
  })));
  return map;
}
export async function fetchInternalsByTxHash(txhash) {
  const url = buildUrl({ module: 'account', action: 'txlistinternal', txhash });
  const j = await getJSON(url);
  return Array.isArray(j?.result) ? j.result : [];
}
const creatorCache = new Map();
export async function getContractCreator(address) {
  const addr = address.toLowerCase();
  if (creatorCache.has(addr)) return creatorCache.get(addr);
  try {
    const url = buildUrl({ module: 'contract', action: 'getcontractcreation', contractaddresses: addr });
    const j = await getJSON(url);
    const res = Array.isArray(j?.result) ? j.result : [];
    const creator = (res[0]?.contractCreator || '').toLowerCase();
    creatorCache.set(addr, creator || null);
    return creator || null;
  } catch {
    creatorCache.set(addr, null);
    return null;
  }
}
export async function get721Meta(address) {
  const addr = address.toLowerCase();
  if (metaCache.has(addr)) return metaCache.get(addr);
  let symbol = '', name = '';
  try { symbol = await client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'symbol' }); } catch {}
  try { name   = await client.readContract({ address: addr, abi: ERC721_ABI, functionName: 'name'   }); } catch {}
  const meta = { symbol: String(symbol || ''), name: String(name || '') };
  metaCache.set(addr, meta);
  return meta;
}

// Classification helpers
const emptyInput = (d) => /^0x0*$/i.test(d || '0x');
const isPrecompile = (to) => (to || '').toLowerCase().startsWith('0x0000000000000000000000000000000000000');

function isFailed(rcpt) {
  const s = rcpt?.status;
  return s === 'reverted' || s === 0 || s === 0n || s === '0' || s === '0x0';
}
function isDomainBySigOrEvent(tx, rcpt) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('registerdomains') || fn.includes('registerdomain') ||
             (fn.includes('register') && (fn.includes('domain') || fn.includes('name'))) ||
             fn.includes('zns'))) return true;
  if (DOMAIN_SELECTORS.has(sig)) return true;
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (DOMAIN_TOPICS.has(t0)) return true;
  }
  return false;
}
function mintedContractsForUser(rcpt, user) {
  const set = new Set();
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (t0 === TOPIC_ERC721_TRANSFER.toLowerCase()) {
      const from = addrFromTopic(lg.topics?.[1] || '');
      const to   = addrFromTopic(lg.topics?.[2] || '');
      if (from === ZERO.toLowerCase() && to === user) set.add(String(lg.address || '').toLowerCase());
    }
    if (t0 === TOPIC_ERC1155_SINGLE.toLowerCase() || t0 === TOPIC_ERC1155_BATCH.toLowerCase()) {
      const from = addrFromTopic(lg.topics?.[2] || '');
      const to   = addrFromTopic(lg.topics?.[3] || '');
      if (from === ZERO.toLowerCase() && to === user) set.add(String(lg.address || '').toLowerCase());
    }
  }
  return set;
}
function isStake(tx, rcpt) {
  const toAddr = (tx.to || '').toLowerCase();
  if (toAddr === '0x0000000000000000000000000000000000000800') return true;
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('bondextra') || fn.includes('bond') || fn.includes('stake') ||
             fn.includes('delegate') || fn.includes('nominate') || fn.includes('unbond') ||
             fn.includes('withdraw') || fn.includes('restake') || fn.includes('redelegate')))
    return true;
  if (STAKE_SELECTORS.has(sig)) return true;
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (STAKE_TOPICS.has(t0)) return true;
  }
  return false;
}
function isGM(tx) {
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn && (fn.includes('saygm') || fn === 'gm')) return true;
  if (GM_SELECTORS.has(sig)) return true;
  return false;
}
function isCCO(tx) {
  const to = (tx.to || '').toLowerCase();
  return to === CCO_TARGET;
}
function isContractCreation(tx, rcpt, user, internalsByHash) {
  if ((tx.to == null || tx.to === '0x') && String(tx.from || '').toLowerCase() === user) return true;
  if (rcpt?.contractAddress && String(tx.from || '').toLowerCase() === user) return true;
  const list = internalsByHash.get(String(tx.hash || '').toLowerCase()) || [];
  return list.some(i => {
    const typ = String(i.type || '').toLowerCase();
    const created = (i.contractAddress || '').toLowerCase();
    return (typ === 'create' || typ === 'create2' || created) && String(tx.from || '').toLowerCase() === user;
  });
}
function getCreatedContractsForTx(tx, rcpt, internalsByHash) {
  const created = new Set();
  if (rcpt?.contractAddress) created.add(String(rcpt.contractAddress).toLowerCase());
  const list = internalsByHash.get(String(tx.hash || '').toLowerCase()) || [];
  for (const i of list) {
    const typ = String(i.type || '').toLowerCase();
    const addr = (i.contractAddress || '').toLowerCase();
    if (typ === 'create' || typ === 'create2' || addr) created.add(addr);
  }
  return [...created].filter(Boolean);
}
function isNativeSend(tx, rcpt, user, eoaMap) {
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  const val = BigInt(tx.value || '0');
  if (from !== user) return false;
  if (!to) return false;
  if (isPrecompile(to)) return false;
  if (val <= 0n) return false;
  if (!emptyInput(tx.input)) return false;
  if (!rcpt || (rcpt.logs || []).length === 0) return true; // pure value
  return eoaMap.get(to) === true;
}
function hasAnyTopic(rcpt, topicsSet) {
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (topicsSet.has(t0)) return true;
  }
  return false;
}
function isSwap(tx, rcpt) {
  if (rcpt && isFailed(rcpt)) return false;
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (hasAnyTopic(rcpt, new Set([TOPIC_UNIV2_SWAP.toLowerCase(), TOPIC_UNIV3_SWAP.toLowerCase()]))) return true;
  if (fn.includes('swap') || fn.includes('exactinput') || fn.includes('exactoutput')) return true;
  if (SWAP_SELECTORS.has(sig)) return true;
  return false;
}
function isAddLiquidity(tx, rcpt) {
  if (rcpt && isFailed(rcpt)) return false;
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (hasAnyTopic(rcpt, new Set([TOPIC_UNIV2_MINT.toLowerCase(), TOPIC_UNIV3_MINT.toLowerCase(), TOPIC_UNIV3_INCREASE_LIQ.toLowerCase()]))) return true;
  if (fn.includes('addliquidity') || fn.includes('mint') || fn.includes('increaseliquidity')) return true;
  if (ADD_LIQ_SELECTORS.has(sig)) return true;
  return false;
}
function isRemoveLiquidity(tx, rcpt) {
  if (rcpt && isFailed(rcpt)) return false;
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (hasAnyTopic(rcpt, new Set([TOPIC_UNIV2_BURN.toLowerCase(), TOPIC_UNIV3_DECREASE_LIQ.toLowerCase()]))) return true;
  if (fn.includes('removeliquidity') || fn.includes('decreaseliquidity')) return true;
  if (REM_LIQ_SELECTORS.has(sig)) return true;
  return false;
}
function isApprove(tx, rcpt) {
  if (rcpt && isFailed(rcpt)) return false;
  const sig = inputSig(tx);
  const fn = String(tx.functionName || '').toLowerCase();
  if (fn === 'approve' || fn.includes('allowance') || fn.includes('approval')) return true;
  if (APPROVE_SELECTORS.has(sig)) return true;
  for (const lg of rcpt?.logs || []) {
    const t0 = (lg.topics?.[0] || '').toLowerCase();
    if (t0 === TOPIC_ERC20_APPROVAL.toLowerCase() ||
        t0 === TOPIC_ERC721_APPROVAL.toLowerCase() ||
        t0 === TOPIC_ERC1155_APPROVAL_ALL.toLowerCase()) return true;
  }
  return false;
}

// Hydrate helpers
async function hydrateMissingExternalsFromInternals({ internalsFeed, externals, address, limit = 400 }) {
  const extSet = new Set((externals || []).map(t => String(t.hash || '').toLowerCase()));
  const intByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    intByHash.set(h, it);
  }
  const missing = [...intByHash.keys()].filter(h => !extSet.has(h)).slice(0, limit);
  if (!missing.length) return externals;

  const limitRun = pLimit(8);
  const fetched = await Promise.all(missing.map(h => limitRun(async () => {
    try {
      const tx = await client.getTransaction({ hash: h });
      if (!tx) return null;
      const it = intByHash.get(h);
      const ts = Number(it?.timeStamp || 0);
      return {
        hash: h,
        blockNumber: Number(tx.blockNumber || 0),
        timeStamp: ts ? String(ts) : undefined,
        from: String(tx.from || '').toLowerCase(),
        to: tx.to ? String(tx.to).toLowerCase() : null,
        value: (typeof tx.value === 'bigint') ? tx.value.toString() : String(tx.value || '0'),
        input: tx.input || '0x',
        functionName: ''
      };
    } catch { return null; }
  })));
  return [...externals, ...fetched.filter(Boolean)];
}
async function hydrateMissingExternalsFromTokenFeeds({ token20, token721, token1155, externals, limit = 800 }) {
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

  const limitRun = pLimit(8);
  const fetched = await Promise.all(missing.map(h => limitRun(async () => {
    try {
      const tx = await client.getTransaction({ hash: h });
      if (!tx) return null;
      const ts = tsMap.get(h) || 0;
      return {
        hash: h,
        blockNumber: Number(tx.blockNumber || 0),
        timeStamp: ts ? String(ts) : undefined,
        from: String(tx.from || '').toLowerCase(),
        to: tx.to ? String(tx.to).toLowerCase() : null,
        value: (typeof tx.value === 'bigint') ? tx.value.toString() : String(tx.value || '0'),
        input: tx.input || '0x',
        functionName: ''
      };
    } catch { return null; }
  })));
  return [...externals, ...fetched.filter(Boolean)];
}

// Core: build activity
export async function buildActivity({ address, start, end }) {
  const addr = address.toLowerCase();

  // Feeds
  let externals = await fetchPagedAccount('txlist', addr, { startTs: start, endTs: end });
  const [internalsFeed, erc20, erc721, erc1155] = await Promise.all([
    fetchPagedAccount('txlistinternal', addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokentx', addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokennfttx', addr, { startTs: start, endTs: end }),
    fetchPagedAccount('token1155tx', addr, { startTs: start, endTs: end }).catch(() => []),
  ]);

  // Ensure inputs, then hydrate older tx from internals/token feeds
  externals = await fillMissingInputs(externals);
  externals = await hydrateMissingExternalsFromInternals({ internalsFeed, externals, address: addr, limit: 400 });
  externals = await hydrateMissingExternalsFromTokenFeeds({ token20: erc20, token721: erc721, token1155: erc1155, externals, limit: 800 });

  // Receipts / EOA map
  const hashes = externals.map(t => t.hash).filter(Boolean);
  const [receipts, eoaMap] = await Promise.all([
    getReceiptsCached(hashes),
    buildEOAMap(addr, externals)
  ]);
  const rcptMap = new Map(receipts.map(r => [r.transactionHash.toLowerCase(), r]));

  // Internals per tx (augment deploy suspects)
  const internalsByHash = new Map();
  for (const it of internalsFeed || []) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    const arr = internalsByHash.get(h) || [];
    arr.push(it);
    internalsByHash.set(h, arr);
  }
  const deploySuspects = (externals || []).filter(t => String(t.functionName || '').toLowerCase().includes('deploy'));
  for (const t of deploySuspects) {
    const h = String(t.hash || '').toLowerCase();
    if (!internalsByHash.has(h) || !internalsByHash.get(h).some(i => (String(i.type || '').toLowerCase().startsWith('create') || i.contractAddress))) {
      try {
        const byTx = await fetchInternalsByTxHash(t.hash);
        if (byTx.length) {
          const arr = internalsByHash.get(h) || [];
          internalsByHash.set(h, [...arr, ...byTx]);
        }
      } catch {}
    }
  }

  // Contracts you deployed within window
  const createdContracts = new Set();
  for (const t of externals || []) {
    const rcpt = rcptMap.get(String(t.hash || '').toLowerCase());
    const created = getCreatedContractsForTx(t, rcpt, internalsByHash);
    for (const c of created) createdContracts.add(c);
  }

  // Domain mints by feed
  const domainTxFromFeed = new Set(
    (Array.isArray(erc721) ? erc721 : [])
      .filter(n => String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr)
      .filter(n => looksLikeDomainText(n.tokenSymbol) || looksLikeDomainText(n.tokenName))
      .map(n => String(n.hash || n.transactionHash || '').toLowerCase())
  );

  // NFT mints by feed (ERC-721 + ERC-1155)
  const nftMintFromFeed = new Set([
    ...((Array.isArray(erc721) ? erc721 : [])
      .filter(n => String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr)
      .map(n => String(n.hash || n.transactionHash || '').toLowerCase())),
    ...((Array.isArray(erc1155) ? erc1155 : [])
      .filter(m => String(m.from || '').toLowerCase() === ZERO.toLowerCase() && String(m.to || '').toLowerCase() === addr)
      .map(m => String(m.hash || m.transactionHash || '').toLowerCase())),
  ]);

  // Classify externals with priority:
  // fail > cc/cco/gm (overrides) > domain > cc (heuristic) > stake > swap/add/remove > gm(sig) > approve > native_send > nft_mint > other
  const nativeRows = [];
  for (const t of externals || []) {
    const rcpt = rcptMap.get(String(t.hash || '').toLowerCase());
    const toLower = (t.to || '').toLowerCase();
    const txhashLower = String(t.hash || '').toLowerCase();

    let category = 'other';
    let toOverride = null;

    if (isFailed(rcpt)) {
      category = 'fail';
    } else if (CC_CONTRACTS.has(toLower)) {
      category = 'cc';
    } else if (isCCO(t)) {
      category = 'cco';
    } else if (GM_CONTRACTS.has(toLower)) {
      category = 'gm';
    } else {
      // Domain detection
      let isDomain = false;
      if (domainTxFromFeed.has(txhashLower) || isDomainBySigOrEvent(t, rcpt)) {
        isDomain = true;
      } else if (rcpt) {
        const set = mintedContractsForUser(rcpt, addr);
        for (const c of set) {
          const meta = await get721Meta(c);
          if (meta && (String(meta.symbol || '').toLowerCase().includes('.zen') ||
                       String(meta.symbol || '').toLowerCase().includes('.ztc') ||
                       String(meta.name || '').toLowerCase().includes('.zen') ||
                       String(meta.name || '').toLowerCase().includes('.ztc'))) { isDomain = true; break; }
        }
      }

      // NFT mint detection (robust)
      const sig = inputSig(t);
      const looksLikeMintSelector = NFT_MINT_SELECTORS.has(sig) || String(t.functionName || '').toLowerCase().includes('mint') || String(t.functionName || '').toLowerCase().includes('claim');
      const isMintByLogs = rcpt ? (mintedContractsForUser(rcpt, addr).size > 0) : false;
      const isMintByFeed = nftMintFromFeed.has(txhashLower);

      if (isDomain) {
        category = 'domain_mint';
      } else if (isContractCreation(t, rcpt, addr, internalsByHash)) {
        category = 'cc';
        const created = getCreatedContractsForTx(t, rcpt, internalsByHash);
        if (created.length) toOverride = created[0];
      } else if (isStake(t, rcpt)) {
        category = 'stake';
      } else if (isSwap(t, rcpt)) {
        category = 'swap';
      } else if (isAddLiquidity(t, rcpt)) {
        category = 'add_liquidity';
      } else if (isRemoveLiquidity(t, rcpt)) {
        category = 'remove_liquidity';
      } else if (isGM(t)) {
        category = 'gm';
      } else if (isApprove(t, rcpt)) {
        category = 'approve';
      } else if (isNativeSend(t, rcpt, addr, eoaMap)) {
        category = 'native_send';
      } else if (isMintByLogs || isMintByFeed || looksLikeMintSelector) {
        // Fallback last: mark as NFT mint if logs/feed/selectors suggest it
        category = 'nft_mint';
      }
    }

    nativeRows.push({
      kind: 'native',
      hash: t.hash,
      blockNumber: Number(t.blockNumber || 0),
      timeMs: Number(t.timeStamp) * 1000,
      from: (t.from || '').toLowerCase(),
      to: toOverride || (t.to ? String(t.to).toLowerCase() : null),
      direction: ((t.from || '').toLowerCase() === addr) ? 'out' : 'in',
      value: formatUnits(t.value || '0', 18),
      valueNorm: Number(formatUnits(t.value || '0', 18)),
      category
    });
  }

  // Internals & tokens (visible; dedupe keeps native)
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

  // Tag token rows as nft_mint if feed shows ZERO -> you (so mint appears even if native row was "other")
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
      direction: ((n.from || '').toLowerCase() === addr) ? 'out' : 'in',
      contract: (n.contractAddress || '').toLowerCase() || undefined,
      symbol: n.tokenSymbol || 'NFT',
      tokenId: String(n.tokenID ?? n.tokenId ?? ''),
      valueNorm: 0,
      category: isMintFromFeed ? 'nft_mint' : null
    };
  });

  // Merge + dedupe with priority
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
    if (r.kind === 'token') {
      // Raise token nft_mint above native 'other' so mint doesn't get hidden
      return (r.category === 'nft_mint') ? 85 : 20;
    }
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

// Stats derived from activity (OUTGOING externals only)
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