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

// Best-effort caches (help on serverless warm instances)
const receiptCache = new Map(); // txHashLower -> receipt
const codeCache = new Map();    // addressLower -> bytecode string or '0x' (EOA)
const metaCache = new Map();    // nftContractLower -> { symbol, name }

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

// Explorer paging
export async function fetchPagedAccount(action, address, { startTs, endTs }, opts = {}) {
  let pageSize = opts.pageSize ?? 100;
  let maxPages = opts.maxPages ?? 20;
  if (startTs === 0) maxPages = Math.max(maxPages, 250); // All time

  const out = [];
  let page = 1;
  while (page <= maxPages) {
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
  return out.filter(x => {
    const ts = Number(x.timeStamp || 0);
    return ts >= startTs && ts <= endTs;
  });
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
const CCO_TARGET = '0x016ef0f56d7344d0e55f6bc2a20618e02dae8be0'.toLowerCase(); // special deploy-via contract

// CONTRACT OVERRIDES (force category by "to" address; lowercase)
const GM_CONTRACTS = new Set([
  '0xf617d89a811a39f06f5271f89db346a0ae297f71', // GM
  '0x1290b4f2a419a316467b580a088453a233e9adcc' // GM
]);
const CC_CONTRACTS = new Set([
  '0x2f96d7dd813b8e17071188791b78ea3fab5c109c' // CC (deploy)
]);

// Signatures/topics
const sel = (sig) => '0x' + keccak256(toBytes(sig)).slice(2, 10);
const topic = (sig) => keccak256(toBytes(sig));
const addrFromTopic = (t) => (t && t.length >= 66) ? ('0x' + t.slice(26)).toLowerCase() : null;

const TOPIC_ERC721_TRANSFER = topic('Transfer(address,address,uint256)');
const TOPIC_ERC1155_SINGLE = topic('TransferSingle(address,address,address,uint256,uint256)');
const TOPIC_ERC1155_BATCH  = topic('TransferBatch(address,address,address,uint256[],uint256[])');

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

// ERC-721 meta
const ERC721_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name',   stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] }
];

// RPC helpers
async function getReceiptsCached(hashes, max = 1200, batch = 25) {
  const out = [];
  const miss = [];
  for (const h of hashes) {
    const k = String(h).toLowerCase();
    if (receiptCache.has(k)) out.push(receiptCache.get(k));
    else miss.push(k);
  }
  const take = miss.slice(0, max);
  for (let i = 0; i < take.length; i += batch) {
    const chunk = take.slice(i, i + batch);
    const results = await Promise.allSettled(chunk.map(k => client.getTransactionReceipt({ hash: k })));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        const rec = r.value;
        receiptCache.set(chunk[idx], rec);
        out.push(rec);
      }
    });
  }
  return out;
}
export async function fillMissingInputs(externals) {
  const missing = externals.filter(t => !t.input);
  if (!missing.length) return externals;
  const map = new Map();
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const rs = await Promise.allSettled(chunk.map(t => client.getTransaction({ hash: t.hash })));
    rs.forEach((r, idx) => {
      const h = chunk[idx].hash.toLowerCase();
      if (r.status === 'fulfilled') map.set(h, r.value);
    });
  }
  for (const t of externals) {
    if (!t.input) {
      const tx = map.get(String(t.hash).toLowerCase());
      if (tx?.input) t.input = tx.input;
    }
  }
  return externals;
}
export async function buildEOAMap(address, externals) {
  const targets = new Set();
  for (const t of externals) {
    const from = (t.from || '').toLowerCase();
    const to = (t.to || '').toLowerCase();
    const val = BigInt(t.value || '0');
    if (from === address && to && val > 0n) targets.add(to);
  }
  const list = [...targets];
  const map = new Map();
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const rs = await Promise.allSettled(chunk.map(async a => {
      const k = a.toLowerCase();
      if (codeCache.has(k)) return codeCache.get(k);
      const code = await client.getBytecode({ address: a });
      codeCache.set(k, code || '0x');
      return code || '0x';
    }));
    rs.forEach((r, idx) => {
      const addr = chunk[idx].toLowerCase();
      const code = r.status === 'fulfilled' ? r.value : '0x';
      map.set(addr, !code || code === '0x');
    });
  }
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
const emptyInput = (d) => /^0x0*$/i.test(d || '0x'); // single definition
const isPrecompile = (to) => (to || '').toLowerCase().startsWith('0x0000000000000000000000000000000000000');

// STRICT domain text matcher (fixes false positives)
// Matches only clear naming systems; avoids generic "name" or any random dot.
const looksLikeDomainText = (s) => {
  if (!s) return false;
  const x = String(s).toLowerCase();

  // Explicit Zenchain-style TLDs
  if (x.includes('.ztc') || x.includes('.zen')) return true;

  // Common name-service acronyms
  if (/\b(zns|ens)\b/.test(x)) return true;

  // Strong naming-related phrases
  if (/\b(name service|domain service|domain registrar|registry|name registry)\b/.test(x)) return true;

  // No generic "name" or any '.' fallback anymore
  return false;
};

function isFailed(rcpt) {
  const s = rcpt?.status;
  return s === 'reverted' || s === 0 || s === 0n || s === '0' || s === '0x0';
}
function isDomainBySigOrEvent(tx, rcpt) {
  const sig = String(tx.input || '').slice(0, 10).toLowerCase();
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
  const sig = String(tx.input || '').slice(0, 10).toLowerCase();
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
  const sig = String(tx.input || '').slice(0, 10).toLowerCase();
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
  const list = internalsByHash.get(String(tx.hash).toLowerCase()) || [];
  return list.some(i => {
    const typ = String(i.type || '').toLowerCase();
    const created = (i.contractAddress || '').toLowerCase();
    return (typ === 'create' || typ === 'create2' || created) && String(tx.from || '').toLowerCase() === user;
  });
}
function getCreatedContractsForTx(tx, rcpt, internalsByHash) {
  const created = new Set();
  if (rcpt?.contractAddress) created.add(String(rcpt.contractAddress).toLowerCase());
  const list = internalsByHash.get(String(tx.hash).toLowerCase()) || [];
  for (const i of list) {
    const typ = String(i.type || '').toLowerCase();
    const addr = (i.contractAddress || '').toLowerCase();
    if (typ === 'create' || typ === 'create2' || addr) created.add(addr);
  }
  return [...created].filter(Boolean);
}
export async function isCI(tx, createdSet) {
  const to = (tx.to || '').toLowerCase();
  if (!to) return false;
  if (createdSet.has(to)) return true;

  // Is contract?
  let code = codeCache.get(to);
  if (!code) {
    code = await client.getBytecode({ address: to });
    codeCache.set(to, code || '0x');
  }
  if (!code || code === '0x') return false;

  const creator = await getContractCreator(to);
  return creator && creator === (tx.from || '').toLowerCase();
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

// Core: build activity
export async function buildActivity({ address, start, end }) {
  const addr = address.toLowerCase();

  // Feeds
  let externals = await fetchPagedAccount('txlist', addr, { startTs: start, endTs: end });
  const [internalsFeed, erc20, erc721] = await Promise.all([
    fetchPagedAccount('txlistinternal', addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokentx', addr, { startTs: start, endTs: end }),
    fetchPagedAccount('tokennfttx', addr, { startTs: start, endTs: end }),
  ]);
  externals = await fillMissingInputs(externals);

  // Receipts/EOA map
  const hashes = externals.map(t => t.hash).filter(Boolean);
  const [receipts, eoaMap] = await Promise.all([
    getReceiptsCached(hashes),
    buildEOAMap(addr, externals)
  ]);
  const rcptMap = new Map(receipts.map(r => [r.transactionHash.toLowerCase(), r]));

  // Internals per tx (augment for deploy-named suspects)
  const internalsByHash = new Map();
  for (const it of internalsFeed) {
    const h = String(it.hash || it.transactionHash || '').toLowerCase();
    if (!h) continue;
    const arr = internalsByHash.get(h) || [];
    arr.push(it);
    internalsByHash.set(h, arr);
  }
  const deploySuspects = externals.filter(t => (String(t.functionName || '').toLowerCase().includes('deploy')));
  for (const t of deploySuspects) {
    const h = String(t.hash).toLowerCase();
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
  for (const t of externals) {
    const rcpt = rcptMap.get(String(t.hash).toLowerCase());
    const created = getCreatedContractsForTx(t, rcpt, internalsByHash);
    for (const c of created) createdContracts.add(c);
  }

  // Domain-ish by feed
  const domainTxFromFeed = new Set(
    erc721
      .filter(n => String(n.from || '').toLowerCase() === ZERO.toLowerCase() && String(n.to || '').toLowerCase() === addr)
      .filter(n => looksLikeDomainText(n.tokenSymbol) || looksLikeDomainText(n.tokenName))
      .map(n => String(n.hash || n.transactionHash || '').toLowerCase())
  );

  // Classify externals with priority:
  // fail > (overrides) cc/cco/gm > domain > cc (heuristic) > ci > stake > gm (sig) > native_send > nft > other
  const nativeRows = [];
  for (const t of externals) {
    const rcpt = rcptMap.get(String(t.hash).toLowerCase());
    const toLower = (t.to || '').toLowerCase();
    const txhashLower = String(t.hash).toLowerCase();

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
      let isDomain = false;
      if (domainTxFromFeed.has(txhashLower) || isDomainBySigOrEvent(t, rcpt)) {
        isDomain = true;
      } else if (rcpt) {
        const set = mintedContractsForUser(rcpt, addr);
        for (const c of set) {
          const meta = await get721Meta(c);
          if (looksLikeDomainText(meta.symbol) || looksLikeDomainText(meta.name)) { isDomain = true; break; }
        }
      }

      if (isDomain) {
        category = 'domain_mint';
      } else if (isContractCreation(t, rcpt, addr, internalsByHash)) {
        category = 'cc';
        const created = getCreatedContractsForTx(t, rcpt, internalsByHash);
        if (created.length) toOverride = created[0];
      } else if (await isCI(t, createdContracts)) {
        category = 'ci';
      } else if (isStake(t, rcpt)) {
        category = 'stake';
      } else if (isGM(t)) {
        category = 'gm';
      } else if (isNativeSend(t, rcpt, addr, eoaMap)) {
        category = 'native_send';
      } else {
        const mintedSet = mintedContractsForUser(rcpt, addr);
        if (mintedSet.size > 0) category = 'nft_mint';
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
  const internalRows = internalsFeed.map(it => ({
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
  const token20 = erc20.map(e => {
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
  const token721 = erc721.map(n => ({
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
    category: null
  }));

  // Merge + dedupe with priority
  const all = [...nativeRows, ...internalRows, ...token20, ...token721];
  const prio = (r) => {
    if (r.kind === 'native') {
      const c = r.category;
      if (c === 'fail')        return 125;
      if (c === 'domain_mint') return 120;
      if (c === 'cc')          return 115;
      if (c === 'cco')         return 112;
      if (c === 'ci')          return 110;
      if (c === 'stake')       return 105;
      if (c === 'gm')          return 100;
      if (c === 'native_send') return 95;
      if (c === 'nft_mint')    return 90;
      if (c === 'other')       return 80;
      return 50;
    }
    if (r.kind === 'token')    return 20;
    if (r.kind === 'internal') return 10;
    return 0;
  };
  const best = new Map();
  for (const r of all) {
    const h = String(r.hash || '').toLowerCase();
    const cur = best.get(h);
    if (!cur || prio(r) > prio(cur)) best.set(h, r);
  }
  const activity = [...best.values()].sort((a, b) => b.timeMs - a.timeMs);
  return activity;
}

// Stats (KPIs)
export async function buildStats({ address, start, end }) {
  const addr = address.toLowerCase();
  let externals = await fetchPagedAccount('txlist', addr, { startTs: start, endTs: end });
  externals = await fillMissingInputs(externals);

  const hashes = externals.map(t => t.hash).filter(Boolean);
  const receipts = await getReceiptsCached(hashes);
  const rcptMap = new Map(receipts.map(r => [r.transactionHash.toLowerCase(), r]));

  const internalsByHash = new Map();
  const deploySuspects = externals.filter(t => (String(t.functionName || '').toLowerCase().includes('deploy')));
  for (const t of deploySuspects) {
    try {
      const byTx = await fetchInternalsByTxHash(t.hash);
      if (byTx.length) internalsByHash.set(String(t.hash).toLowerCase(), byTx);
    } catch {}
  }

  let stakeActions = 0, nativeSends = 0, nftMints = 0, domainMints = 0, gmCount = 0, ccCount = 0;

  for (const t of externals) {
    const rcpt = rcptMap.get(String(t.hash).toLowerCase());
    if (!rcpt || isFailed(rcpt)) continue;

    const toLower = (t.to || '').toLowerCase();

    // Overrides first
    if (CC_CONTRACTS.has(toLower)) ccCount += 1;
    if (GM_CONTRACTS.has(toLower)) gmCount += 1;

    // Domain/NFT
    let isDomain = false;
    if (isDomainBySigOrEvent(t, rcpt)) {
      isDomain = true;
    } else {
      const set = mintedContractsForUser(rcpt, addr);
      for (const c of set) {
        const meta = await get721Meta(c);
        if (looksLikeDomainText(meta.symbol) || looksLikeDomainText(meta.name)) { isDomain = true; break; }
      }
    }
    if (isDomain) domainMints += 1;
    else if (mintedContractsForUser(rcpt, addr).size > 0) nftMints += 1;

    // CC/CCO heuristics
    if (isContractCreation(t, rcpt, addr, internalsByHash) || (toLower === CCO_TARGET)) ccCount += 1;

    // GM signature fallback
    if (isGM(t)) gmCount += 1;

    // Native sends (fast estimate)
    const from = (t.from || '').toLowerCase();
    const val = BigInt(t.value || '0');
    if (from === addr && toLower && !isPrecompile(toLower) && val > 0n && emptyInput(t.input)) nativeSends += 1;

    if (isStake(t, rcpt)) stakeActions += 1;
  }

  return { stakeActions, nativeSends, nftMints, domainMints, gmCount, ccCount, bridged: 'coming_soon' };
}