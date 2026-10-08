/**
 * Binance withdraw helper for your current portfolio (single file, no npm deps)
 *
 * Default is SAFE dry-run. Nothing is sent without --confirm.
 *
 *   node withdraw-assets.js                 # plan only
 *   node withdraw-assets.js --all --confirm # redeem? + sell orphans + withdraw
 *   node withdraw-assets.js --sell-to-usdt --confirm
 *   node withdraw-assets.js --withdraw --confirm
 *
 * IMPORTANT:
 *   The addresses in check-balance.js are Binance DEPOSIT addresses.
 *   Put YOUR personal wallet addresses in DEST below.
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || '1FqOYIqHLzacAYQL256nVtXpsQxkbNPtpLt6kp5Zt1OwJ3ZvJWyfJI6LJ2Jn6NEy';
const API_SECRET = process.env.BINANCE_API_SECRET || 'jDWkqh5JNrat3GxcheJFJZKcV3MQhiz3MAYAsoPxnoiStKPuS5prmeSMNWxRzbPi';

/**
 * Fill YOUR personal wallets here (not Binance deposit addresses).
 * Leave blank ('') if you do not have that chain — those coins will be sold to USDT.
 */
const DEST = {
  // MetaMask / Trust — same 0x works on BSC, ETH, Arbitrum, etc.
  EVM: process.env.EVM_ADDRESS || '0xD430c630b2F4f90F471b8d8BDdE36647db0F0702',

  // Phantom / Solflare — for SOL and JUP
  SOL: process.env.SOL_ADDRESS || 'CtsqWruy4p2sbJMxZpj5WkHkwYvKyFPApW1ua4CppdGU',

  // TronLink — for TRX and BTTC
  TRX: process.env.TRX_ADDRESS || 'TNdwSb5fwVvFpS4PdQB72tz8bShtb7ocqz',

  // Bitcoin (native / SegWit)
  BTC: process.env.BTC_ADDRESS || 'bc1qzvk44pust9ngvxgndnfrfxfc6xtf2k0gjnpnep',

  // Cardano
  ADA: process.env.ADA_ADDRESS ||
    'addr1qxees8lez5ef7yddwesllazfq6czv235p88jld75u897dnchlxad685a2v2xcdlf64dfuqn5ndnk6yy7jz6f9g7hvn0s8m4elm',

  // XRP Ledger (destination tag usually not required for personal wallets)
  XRP: process.env.XRP_ADDRESS || 'rw93nD9EU4nFSYGUQTJgiLUQ9AZm58UM3B',
  XRP_TAG: process.env.XRP_TAG || '',

  // Optional native chains (leave blank to sell → USDT, or use EVM/BSC route when available)
  ATOM: process.env.ATOM_ADDRESS || '',
  ATOM_MEMO: process.env.ATOM_MEMO || '', // often required on Cosmos
  CKB: process.env.CKB_ADDRESS || '',
  EOS: process.env.EOS_ADDRESS || '', // Vaulta (A) uses EOS-style account
  EOS_MEMO: process.env.EOS_MEMO || '',
  BCH: process.env.BCH_ADDRESS || '',
};

const USDT_NETWORK = process.env.USDT_NETWORK || 'BSC';
const BASE_URL = 'api.binance.com';
const RECV_WINDOW = 60000;
// ============================

const args = process.argv.slice(2);
const FLAG_CONFIRM = args.includes('--confirm');
const FLAG_SELL = args.includes('--sell-to-usdt') || args.includes('--all');
const FLAG_WITHDRAW = args.includes('--withdraw') || args.includes('--all');
const FLAG_REDEEM = args.includes('--redeem') || args.includes('--all');

const LD_PREFIX = 'LD';
const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);

/**
 * Preferred withdraw route per coin.
 * wallet: which DEST key to use
 * networks: preferred Binance network codes (first withdraw-enabled match wins)
 * If no address is set for that wallet, coin is marked sell-to-usdt (when a market exists).
 */
const ROUTES = {
  USDT: { wallet: 'EVM', networks: [USDT_NETWORK, 'BSC', 'ETH'] },
  USDC: { wallet: 'EVM', networks: [USDT_NETWORK, 'BSC', 'ETH'] },
  ETH: { wallet: 'EVM', networks: ['ETH', 'ARBITRUM', 'BASE', 'BSC'] },
  BNB: { wallet: 'EVM', networks: ['BSC', 'OPBNB'] },
  ARB: { wallet: 'EVM', networks: ['ARBITRUM', 'ETH'] },
  CFX: { wallet: 'EVM', networks: ['CFXEVM', 'BSC'] },
  ETHW: { wallet: 'EVM', networks: ['ETHW', 'BSC'] },
  BCH: { wallet: 'EVM', networks: ['BSC', 'BCH'] }, // BCH wallet used only if network is BCH
  BTC: { wallet: 'BTC', networks: ['SEGWITBTC', 'BTC', 'BSC'] },
  ADA: { wallet: 'ADA', networks: ['ADA', 'BSC'] },
  ATOM: { wallet: 'EVM', networks: ['BSC', 'ATOM'] },
  XRP: { wallet: 'XRP', networks: ['XRP', 'BSC'] },
  SOL: { wallet: 'SOL', networks: ['SOL'] },
  JUP: { wallet: 'SOL', networks: ['SOL'] },
  TRX: { wallet: 'TRX', networks: ['TRX'] },
  BTTC: { wallet: 'TRX', networks: ['TRX', 'BSC'] },
  CKB: { wallet: 'CKB', networks: ['CKB'] },
  A: { wallet: 'EOS', networks: ['EOS', 'A'] }, // Vaulta
  SOLO: { wallet: null, networks: [] }, // usually sell
};

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function toQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

function request(method, path, { query = '', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'X-MBX-APIKEY': API_KEY };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const options = {
      hostname: BASE_URL,
      path: query ? `${path}?${query}` : path,
      method,
      headers,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400 || (json.code && json.code < 0)) {
            const code = json.code != null ? ` [${json.code}]` : '';
            reject(new Error(`${json.msg || data || `HTTP ${res.statusCode}`}${code}`));
          } else {
            resolve(json);
          }
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getServerTime() {
  const data = await request('GET', '/api/v3/time');
  return data.serverTime;
}

async function signedRequest(method, path, params = {}) {
  const timestamp = await getServerTime();
  const payload = toQuery({ ...params, timestamp, recvWindow: RECV_WINDOW });
  const signed = `${payload}&signature=${sign(payload, API_SECRET)}`;
  if (method === 'GET') return request(method, path, { query: signed });
  return request(method, path, { body: signed });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAmount(value, digits = 8) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `$${n.toFixed(2)}`;
}

function underlyingAsset(asset) {
  return asset.startsWith(LD_PREFIX) && asset.length > 2 ? asset.slice(2) : asset;
}

function decimalsFromStep(step) {
  const s = String(step);
  const i = s.indexOf('.');
  if (i === -1) return 0;
  return s.replace(/0+$/, '').length - i - 1;
}

function floorToStep(qty, step) {
  const q = Number(qty);
  const st = Number(step);
  if (!st) return q;
  const dec = decimalsFromStep(step);
  return Number((Math.floor((q + Number.EPSILON) / st) * st).toFixed(Math.max(0, dec)));
}

async function getPrices() {
  const tickers = await request('GET', '/api/v3/ticker/price');
  const map = {};
  for (const t of tickers) map[t.symbol] = Number(t.price);
  return map;
}

function usdPrice(asset, prices) {
  if (STABLE.has(asset)) return asset === 'USDT' ? 1 : prices[`${asset}USDT`] || 1;
  const p = prices[`${asset}USDT`];
  return p && p > 0 ? p : 0;
}

async function getAccountBalances() {
  const account = await signedRequest('GET', '/api/v3/account');
  return (account.balances || [])
    .map((b) => ({
      asset: b.asset,
      free: Number(b.free),
      locked: Number(b.locked),
      total: Number(b.free) + Number(b.locked),
    }))
    .filter((b) => b.total > 0);
}

function findNetwork(networks, wantedList) {
  const enabled = (networks || []).filter((n) => n.withdrawEnable);
  for (const want of wantedList) {
    const w = String(want).toUpperCase();
    const hit = enabled.find((n) => String(n.network).toUpperCase() === w);
    if (hit) return hit;
  }
  return null;
}

function addressForNetwork(walletKey, network) {
  const net = String(network || '').toUpperCase();
  if (walletKey === 'EVM') {
    if (net === 'BTC' || net === 'SEGWITBTC') return DEST.BTC || '';
    if (net === 'ADA') return DEST.ADA || '';
    if (net === 'XRP') return DEST.XRP || '';
    if (net === 'ATOM') return DEST.ATOM || '';
    if (net === 'BCH') return DEST.BCH || DEST.EVM || '';
    return DEST.EVM || '';
  }
  return DEST[walletKey] || '';
}

function memoForNetwork(walletKey, network) {
  const net = String(network || '').toUpperCase();
  if (net === 'XRP') return DEST.XRP_TAG || undefined;
  if (net === 'ATOM') return DEST.ATOM_MEMO || undefined;
  if (walletKey === 'EOS' || net === 'EOS' || net === 'A') return DEST.EOS_MEMO || undefined;
  return undefined;
}

function resolveRoute(coin, coinConfig) {
  const base = underlyingAsset(coin);
  const preset = ROUTES[base];
  const cfg = (coinConfig || []).find((c) => c.coin === base);
  const networks = (cfg && cfg.networkList) || [];

  if (!preset || !preset.wallet) {
    return { action: 'sell-to-usdt', coin: base, reason: 'no route / sell preferred' };
  }

  const net = findNetwork(networks, preset.networks);
  if (!net) {
    return { action: 'sell-to-usdt', coin: base, reason: 'no withdraw-enabled preferred network' };
  }

  let walletKey = preset.wallet;
  const netU = String(net.network).toUpperCase();
  // If preferred fell through to a native network, switch wallet
  if (netU === 'BTC' || netU === 'SEGWITBTC') walletKey = 'BTC';
  if (netU === 'ADA') walletKey = 'ADA';
  if (netU === 'XRP') walletKey = 'XRP';
  if (netU === 'ATOM') walletKey = 'ATOM';
  if (netU === 'BCH' && !String(net.network).includes('BSC')) walletKey = 'BCH';
  if (netU === 'CKB') walletKey = 'CKB';
  if (netU === 'EOS' || netU === 'A') walletKey = 'EOS';
  if (netU === 'SOL') walletKey = 'SOL';
  if (netU === 'TRX') walletKey = 'TRX';

  const address = addressForNetwork(walletKey, net.network);
  if (!address) {
    return {
      action: 'sell-to-usdt',
      coin: base,
      network: net.network,
      reason: `missing DEST.${walletKey} address`,
    };
  }

  const addressTag = memoForNetwork(walletKey, net.network);
  if ((netU === 'XRP' || netU === 'ATOM' || walletKey === 'EOS') && !addressTag) {
    // memo optional on some destinations; warn but allow if Binance does not require it
  }

  return {
    action: 'withdraw',
    coin: base,
    network: net.network,
    address,
    addressTag,
    fee: net.withdrawFee,
    min: net.withdrawMin,
    walletKey,
  };
}

function printNeededAddresses() {
  console.log('\n=== Addresses you need to provide (DEST in withdraw-assets.js) ===\n');
  console.log('REQUIRED for your current bag:');
  console.log('  1. EVM  (0x...)     → USDT, USDC, ETH, BNB, ARB, CFX, ETHW, and BSC-wraps');
  console.log('     current:', DEST.EVM || '(empty)');
  console.log('  2. SOL  (Solana)    → SOL + JUP');
  console.log('     current:', DEST.SOL || '(empty — REQUIRED)');
  console.log('  3. TRX  (Tron)      → TRX + BTTC');
  console.log('     current:', DEST.TRX || '(empty — REQUIRED)');
  console.log('\nOPTIONAL (only if you refuse BSC wrap / want native):');
  console.log('  BTC / ADA / XRP(+tag) / ATOM(+memo) / BCH / CKB / EOS(+memo)');
  console.log('  If blank, those coins use BSC→EVM when possible, else sell to USDT.');
  console.log('\nSOLO / dust without a market or address → sell to USDT (or skipped).');
  console.log('Add each address to your Binance withdrawal whitelist before --confirm.\n');
}

async function printPlan(balances, prices, coinConfig) {
  console.log('\n=== Portfolio + withdraw plan ===\n');
  console.log(
    'Asset'.padEnd(10),
    'Amount'.padStart(16),
    'USD'.padStart(12),
    'Action'.padEnd(14),
    'Network'.padEnd(12),
    'To'
  );
  console.log('-'.repeat(110));

  let total = 0;
  const plan = [];
  for (const b of balances) {
    if (b.asset.startsWith(LD_PREFIX)) continue;
    const base = underlyingAsset(b.asset);
    const usd = b.total * usdPrice(base, prices);
    total += usd;
    const route = resolveRoute(base, coinConfig);
    plan.push({ ...b, base, usd, route });
    console.log(
      b.asset.padEnd(10),
      formatAmount(b.total).padStart(16),
      formatUsd(usd).padStart(12),
      route.action.padEnd(14),
      String(route.network || '-').padEnd(12),
      route.address || route.reason || '-'
    );
  }
  console.log('-'.repeat(110));
  console.log('TOTAL'.padEnd(10), ''.padStart(16), formatUsd(total).padStart(12));
  return plan;
}

async function getEarnPositions() {
  try {
    const data = await signedRequest('GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 });
    return data.rows || [];
  } catch (err) {
    console.log('Simple Earn unavailable:', err.message);
    return [];
  }
}

async function redeemEarn() {
  const positions = await getEarnPositions();
  if (!positions.length) {
    console.log('No Simple Earn positions.');
    return;
  }
  console.log(`\nRedeeming ${positions.length} Earn position(s)...`);
  for (const p of positions) {
    console.log(`  ${p.asset} productId=${p.productId} amount=${p.totalAmount}`);
    if (!FLAG_CONFIRM || !p.productId) continue;
    try {
      const result = await signedRequest('POST', '/sapi/v1/simple-earn/flexible/redeem', {
        productId: p.productId,
        redeemAll: true,
        destAccount: 'SPOT',
      });
      console.log('  OK:', JSON.stringify(result));
    } catch (err) {
      console.log('  Fail:', err.message);
    }
  }
  if (!FLAG_CONFIRM) console.log('Dry-run. Use --redeem --confirm');
}

async function getExchangeFilters(symbol) {
  const info = await request('GET', '/api/v3/exchangeInfo', { query: `symbol=${symbol}` });
  const s = (info.symbols || [])[0];
  if (!s) return null;
  const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE') || {};
  const notional =
    s.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') || {};
  return {
    status: s.status,
    stepSize: Number(lot.stepSize || 0),
    minQty: Number(lot.minQty || 0),
    minNotional: Number(notional.minNotional || notional.notional || 0),
  };
}

async function sellToUsdt(balances, prices, coinConfig) {
  const candidates = balances
    .filter((b) => !b.asset.startsWith(LD_PREFIX) && b.free > 0 && b.asset !== 'USDT')
    .map((b) => {
      const route = resolveRoute(b.asset, coinConfig);
      return {
        ...b,
        route,
        price: usdPrice(b.asset, prices),
        usd: b.free * usdPrice(b.asset, prices),
        symbol: `${b.asset}USDT`,
      };
    })
    .filter((c) => c.route.action === 'sell-to-usdt')
    .sort((a, b) => b.usd - a.usd);

  if (!candidates.length) {
    console.log('\nNo coins marked sell-to-usdt.');
    return;
  }

  console.log('\n=== Sell to USDT ===');
  for (const c of candidates) {
    const filters = await getExchangeFilters(c.symbol);
    if (!filters || filters.status !== 'TRADING') {
      console.log(`Skip ${c.asset}: no ${c.symbol} market (${formatUsd(c.usd)}) — ${c.route.reason}`);
      continue;
    }
    const qty = floorToStep(c.free, filters.stepSize);
    const notional = qty * (c.price || 0);
    if (qty < filters.minQty || (filters.minNotional && notional < filters.minNotional)) {
      console.log(`Skip ${c.asset}: below min (~${formatUsd(c.usd)})`);
      continue;
    }
    console.log(`Sell ${formatAmount(qty)} ${c.asset} → USDT (~${formatUsd(notional)}) [${c.route.reason}]`);
    if (!FLAG_CONFIRM) continue;
    try {
      const order = await signedRequest('POST', '/api/v3/order', {
        symbol: c.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: String(qty),
      });
      console.log('  Order', order.orderId, order.status);
    } catch (err) {
      console.log('  Fail:', err.message);
    }
  }
  if (!FLAG_CONFIRM) console.log('Dry-run. Use --sell-to-usdt --confirm');
}

async function withdrawCoin(job) {
  const balances = await getAccountBalances();
  const bal = balances.find((b) => b.asset === job.coin);
  const free = bal ? bal.free : 0;
  const fee = Number(job.fee || 0);
  const min = Number(job.min || 0);
  const amount = Math.max(0, free); // Binance deducts fee from amount on many networks; send free balance
  // Prefer sending free; if fee is separate Binance still accepts amount <= free
  const sendAmount = amount;

  console.log(`\n${job.coin} free=${formatAmount(free)} network=${job.network} fee=${fee} min=${min}`);
  console.log(`To: ${job.address}${job.addressTag ? ` tag=${job.addressTag}` : ''}`);

  if (sendAmount < min || sendAmount <= 0) {
    console.log(`Skip ${job.coin}: below min/fee`);
    return;
  }
  if (!FLAG_CONFIRM) {
    console.log('Dry-run. Use --withdraw --confirm');
    return;
  }

  const params = {
    coin: job.coin,
    address: job.address,
    amount: String(sendAmount),
    network: job.network,
    walletType: 0,
  };
  if (job.addressTag) params.addressTag = job.addressTag;

  const result = await signedRequest('POST', '/sapi/v1/capital/withdraw/apply', params);
  console.log('Submitted:', JSON.stringify(result));
}

async function withdrawAssets(balances, coinConfig) {
  const jobs = [];
  for (const b of balances) {
    if (b.asset.startsWith(LD_PREFIX) || b.free <= 0) continue;
    const route = resolveRoute(b.asset, coinConfig);
    if (route.action !== 'withdraw') continue;
    jobs.push(route);
  }
  if (!jobs.length) {
    console.log('\nNo withdraw jobs (missing addresses or all marked sell).');
    return;
  }
  console.log(`\n=== Withdraw ${jobs.length} coin(s) ===`);
  for (const job of jobs) {
    try {
      await withdrawCoin(job);
    } catch (err) {
      console.log(`Skip ${job.coin}:`, err.message);
    }
  }
}

function requireKeys() {
  if (
    !API_KEY ||
    !API_SECRET ||
    API_KEY.includes('YOUR_API_KEY') ||
    API_SECRET.includes('YOUR_SECRET_KEY')
  ) {
    console.error('Set BINANCE_API_KEY / BINANCE_API_SECRET (or edit CONFIG).');
    process.exit(1);
  }
}

async function main() {
  requireKeys();
  printNeededAddresses();

  console.log('Fetching balances, prices, networks...');
  const [prices, balances, coinConfig] = await Promise.all([
    getPrices(),
    getAccountBalances(),
    signedRequest('GET', '/sapi/v1/capital/config/getall').catch((err) => {
      console.log('capital/config error:', err.message);
      return [];
    }),
  ]);

  await printPlan(balances, prices, coinConfig);

  const mutating = FLAG_REDEEM || FLAG_SELL || FLAG_WITHDRAW;
  if (!mutating) {
    console.log('\nDry-run only. Next steps:');
    console.log('  1. Fill DEST.SOL and DEST.TRX (and keep DEST.EVM).');
    console.log('  2. Whitelist those addresses on Binance API key.');
    console.log('  3. node withdraw-assets.js --all --confirm');
    return;
  }

  if (FLAG_CONFIRM) {
    console.log('\n*** LIVE MODE ***');
    console.log('EVM:', DEST.EVM || '(empty)');
    console.log('SOL:', DEST.SOL || '(empty)');
    console.log('TRX:', DEST.TRX || '(empty)');
    await sleep(3000);
  } else {
    console.log('\n*** DRY RUN (add --confirm to execute) ***');
  }

  if (FLAG_REDEEM) {
    await redeemEarn();
    if (FLAG_CONFIRM) await sleep(5000);
  }

  if (FLAG_SELL) {
    const fresh = FLAG_CONFIRM ? await getAccountBalances() : balances;
    await sellToUsdt(fresh, prices, coinConfig);
    if (FLAG_CONFIRM) await sleep(3000);
  }

  if (FLAG_WITHDRAW) {
    const fresh = FLAG_CONFIRM ? await getAccountBalances() : balances;
    await withdrawAssets(fresh, coinConfig);
  }
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  process.exit(1);
});
