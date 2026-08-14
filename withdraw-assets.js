/**
 * Binance portfolio USD value + withdraw helper (single file, no npm deps)
 *
 * Default is SAFE: prints USD value and a plan. It does NOT send funds.
 *
 *   node withdraw-assets.js
 *   node withdraw-assets.js --redeem --confirm
 *   node withdraw-assets.js --sell-to-usdt --confirm
 *   node withdraw-assets.js --withdraw --confirm
 *   node withdraw-assets.js --all --confirm
 *
 * Routing:
 *   NEAR                         → NEAR_ADDRESS on NEAR
 *   EVM coins (USDT, INJ, S, …)  → EVM_ADDRESS on a matching 0x network
 *   coins with no matching chain → sell to USDT, then withdraw USDT
 *   LD*                          → redeem Simple Earn first
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || 'NdUlUMfaJRHsJ51yMkqRQ1VNFhvsUFhJFWkckxqKHi4e7K0SDOjMKh5ag8OZyn7S';
const API_SECRET = process.env.BINANCE_API_SECRET || 'v62XKftFJofkXz9rZxBNDmD0XgVX0XXp74ZT6mXmlV3LLPPZr8hG8rvyVMld29dY';
const EVM_ADDRESS =
  process.env.WITHDRAW_ADDRESS || '0x8fFE47791c35Bc7995aA899Be07a42a4Eb3F8701';
const NEAR_ADDRESS =
  process.env.NEAR_ADDRESS ||
  '50d977e40268ede1640f9c49c4a7656f447d82399b3554bda1e5a10c60db5416';
// BEP20 (BSC) is cheap and uses the same 0x address. Add BNB Smart Chain in MetaMask first.
// Use 'ETH' if you only want Ethereum mainnet (higher fee).
const USDT_NETWORK = process.env.USDT_NETWORK || 'BSC';
const NEAR_NETWORK = process.env.NEAR_NETWORK || 'NEAR';
const BASE_URL = 'api.binance.com';
const RECV_WINDOW = 60000;
// ============================

const args = process.argv.slice(2);
const FLAG_CONFIRM = args.includes('--confirm');
const FLAG_REDEEM = args.includes('--redeem') || args.includes('--all');
const FLAG_SELL = args.includes('--sell-to-usdt') || args.includes('--all');
const FLAG_WITHDRAW = args.includes('--withdraw') || args.includes('--all');

const LD_PREFIX = 'LD';
const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);
const FALLBACK_USD = {
  SOLO: 0.01262,
  FLR: 0.00598,
  SUSD: 0.67,
};
const EVM_NETWORKS = [
  'BSC',
  'ETH',
  'ARBITRUM',
  'OPTIMISM',
  'BASE',
  'POLYGON',
  'MATIC',
  'AVAXC',
  'AVAX-C',
  'OPBNB',
  'FLR',
  'FLARE',
  'SONIC',
  'FTM',
  'SCROLL',
  'LINEA',
  'BLAST',
];
const PREFERRED_NETWORK = {
  USDT: [USDT_NETWORK, 'BSC', 'ETH'],
  USDC: [USDT_NETWORK, 'BSC', 'ETH'],
  ETH: ['ETH'],
  INJ: ['ETH'],
  FLR: ['FLR', 'FLARE'],
  POL: ['MATIC', 'POLYGON', 'POL'],
  S: ['SONIC', 'S', 'FTM'],
  SXT: ['ETH'],
  SUSD: ['ETH'],
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

async function signedRequest(method, path, params = {}) {
  const timestamp = await getServerTime();
  const payload = toQuery({ ...params, timestamp, recvWindow: RECV_WINDOW });
  const signature = sign(payload, API_SECRET);
  const signed = `${payload}&signature=${signature}`;
  if (method === 'GET') return request(method, path, { query: signed });
  return request(method, path, { body: signed });
}

function publicGet(path, query = '') {
  return request('GET', path, { query });
}

async function getServerTime() {
  const data = await publicGet('/api/v3/time');
  return data.serverTime;
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
  const floored = Math.floor((q + Number.EPSILON) / st) * st;
  return Number(floored.toFixed(Math.max(0, dec)));
}

async function getPrices() {
  const tickers = await publicGet('/api/v3/ticker/price');
  const map = {};
  for (const t of tickers) map[t.symbol] = Number(t.price);
  return map;
}

function usdPrice(asset, prices) {
  if (STABLE.has(asset)) return asset === 'USDT' ? 1 : prices[`${asset}USDT`] || 1;
  const p = prices[`${asset}USDT`];
  if (p && p > 0) return p;
  if (FALLBACK_USD[asset]) return FALLBACK_USD[asset];
  return 0;
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

async function getEarnPositions() {
  try {
    const data = await signedRequest('GET', '/sapi/v1/simple-earn/flexible/position', {
      size: 100,
    });
    return data.rows || data || [];
  } catch (err) {
    console.log('Simple Earn positions unavailable:', err.message);
    return [];
  }
}

async function printValuation(balances, prices) {
  console.log('\n=== Portfolio (USD estimate) ===\n');
  console.log(
    'Asset'.padEnd(12),
    'Amount'.padStart(16),
    'USD price'.padStart(14),
    'USD value'.padStart(14),
    'Note'
  );
  console.log('-'.repeat(78));

  let total = 0;
  const rows = [];

  for (const b of balances) {
    const base = underlyingAsset(b.asset);
    const price = usdPrice(base, prices);
    const usd = b.total * price;
    total += usd;
    const note = b.asset.startsWith(LD_PREFIX)
      ? `Simple Earn ${base}`
      : price
        ? ''
        : 'no live price';
    rows.push({ ...b, base, price, usd, note });
    console.log(
      b.asset.padEnd(12),
      formatAmount(b.total).padStart(16),
      (price ? formatUsd(price) : 'n/a').padStart(14),
      formatUsd(usd).padStart(14),
      ' ' + note
    );
  }

  console.log('-'.repeat(78));
  console.log('TOTAL USD'.padEnd(12), ''.padStart(16), ''.padStart(14), formatUsd(total).padStart(14));
  console.log('\nPrices are spot estimates. Illiquid coins (SUSD/SOLO/FLR) may differ.');
  return { total, rows };
}

function isEvmNetwork(n) {
  const net = String(n.network || '').toUpperCase();
  const name = String(n.name || '').toUpperCase();
  if (net === 'NEAR' || name.includes('NEAR PROTOCOL')) return false;
  if (net === 'INJ' || net === 'INJECTIVE' || name.includes('INJECTIVE')) {
    return name.includes('ERC20') || name.includes('ETHEREUM') || net === 'ETH';
  }
  return EVM_NETWORKS.some((x) => net === x || name.includes(x));
}

function pickRoute(coin, coinConfig) {
  if (coin === 'NEAR') {
    return { action: 'withdraw', networkHint: NEAR_NETWORK, address: NEAR_ADDRESS };
  }
  const cfg = (coinConfig || []).find((c) => c.coin === coin);
  const networks = ((cfg && cfg.networkList) || []).filter((n) => n.withdrawEnable);
  const preferred = PREFERRED_NETWORK[coin] || [];
  const evmNets = networks.filter(isEvmNetwork);
  const picked =
    preferred
      .map((want) =>
        evmNets.find((n) => String(n.network).toUpperCase() === String(want).toUpperCase())
      )
      .find(Boolean) || evmNets[0];
  if (picked) {
    return { action: 'withdraw', networkHint: picked.network, address: EVM_ADDRESS };
  }
  return { action: 'sell-to-usdt', networkHint: '-', address: '-' };
}

function printPlan(rows, coinConfig = []) {
  console.log('\n=== Withdrawal plan ===\n');
  console.log('NEAR →', NEAR_ADDRESS, `(${NEAR_NETWORK})`);
  console.log('EVM  →', EVM_ADDRESS, `(USDT prefers ${USDT_NETWORK})`);
  console.log('');
  console.log('Per-asset routing:');
  for (const r of rows) {
    const route = pickRoute(r.base, coinConfig);
    console.log(
      `  ${r.asset.padEnd(12)} ${formatUsd(r.usd).padStart(10)}  ${route.action.padEnd(12)}  ${String(
        route.networkHint
      ).padEnd(10)}  ${route.address}`
    );
  }
  console.log('');
  console.log('Steps:');
  console.log('  1. Redeem Simple Earn (LD*) back to spot.');
  console.log('  2. Sell only coins with no EVM/NEAR network (BTC, LUNA, SOLO, …).');
  console.log('  3. Withdraw each remaining coin to the matching address.');
  console.log('  4. Dust below min withdraw/sell is skipped.\n');

  const earn = rows.filter((r) => r.asset.startsWith(LD_PREFIX));
  const spot = rows.filter((r) => !r.asset.startsWith(LD_PREFIX));
  if (earn.length) {
    console.log('Must redeem first:');
    for (const r of earn) {
      console.log(`  - ${r.asset} → ${r.base}  (${formatAmount(r.total)}, ${formatUsd(r.usd)})`);
    }
  }
  if (spot.length) {
    console.log('Already in spot:');
    for (const r of spot) {
      console.log(`  - ${r.asset}  (${formatAmount(r.total)}, ${formatUsd(r.usd)})`);
    }
  }

  console.log('\nAPI key must have: Read, Spot trading, and Withdraw.');
  console.log('Withdrawals often also need a whitelisted address and IP whitelist.');
  console.log('\nDry-run by default. Add --confirm to execute the selected step(s).');
}

async function getApiRestrictions() {
  try {
    return await signedRequest('GET', '/sapi/v1/account/apiRestrictions');
  } catch (err) {
    console.log('Could not read API key permissions:', err.message);
    return null;
  }
}

function printPermissions(perm) {
  if (!perm) return;
  console.log('\nAPI key permissions:');
  console.log('  Reading           :', !!perm.enableReading);
  console.log('  Spot trading      :', !!perm.enableSpotAndMarginTrading);
  console.log('  Withdrawals       :', !!perm.enableWithdrawals);
  console.log('  IP restrict       :', !!perm.ipRestrict);
  if (!perm.enableSpotAndMarginTrading) {
    console.log(
      '\nEnable "Spot & Margin Trading" on this API key, or Simple Earn redeem/sell will fail.'
    );
  }
  if (!perm.enableWithdrawals) {
    console.log('Enable "Enable Withdrawals" on this API key, or withdraw will fail.');
  }
}

function isAuthError(err) {
  const msg = String((err && err.message) || err);
  return /not authorized|-2015|-1002|-2014/i.test(msg);
}

async function redeemOne(p) {
  const amount = p.totalAmount || p.latestAmount || p.amount;
  try {
    return await signedRequest('POST', '/sapi/v1/simple-earn/flexible/redeem', {
      productId: p.productId,
      redeemAll: true,
      destAccount: 'SPOT',
    });
  } catch (err) {
    if (isAuthError(err) || !amount) throw err;
    return signedRequest('POST', '/sapi/v1/simple-earn/flexible/redeem', {
      productId: p.productId,
      amount: String(amount),
      destAccount: 'SPOT',
    });
  }
}

async function redeemEarn() {
  const positions = await getEarnPositions();
  if (!positions.length) {
    console.log('No Simple Earn flexible positions found.');
    return { ok: 0, failed: 0 };
  }

  const ordered = [...positions].sort((a, b) => {
    const aa = Number(a.totalAmount || a.latestAmount || a.amount || 0);
    const bb = Number(b.totalAmount || b.latestAmount || b.amount || 0);
    return bb - aa;
  });

  console.log(`\nFound ${ordered.length} Simple Earn position(s).`);
  let ok = 0;
  let failed = 0;
  for (const p of ordered) {
    const asset = p.asset || p.productId;
    const amount = p.totalAmount || p.latestAmount || p.amount;
    console.log(`  ${asset}  productId=${p.productId}  amount=${amount}`);
    if (!FLAG_CONFIRM) continue;
    if (!p.productId) continue;
    try {
      const result = await redeemOne(p);
      ok += 1;
      console.log('  Redeemed:', JSON.stringify(result));
    } catch (err) {
      failed += 1;
      console.log(`  Redeem failed for ${asset}:`, err.message || err);
      if (isAuthError(err)) {
        console.log(
          '  API key cannot redeem Simple Earn. Enable Spot & Margin Trading, then re-run.'
        );
        break;
      }
    }
  }

  if (!FLAG_CONFIRM) {
    console.log('Redeem not sent (dry-run). Re-run with --redeem --confirm');
  }
  return { ok, failed };
}

async function getExchangeFilters(symbol) {
  const info = await publicGet('/api/v3/exchangeInfo', `symbol=${symbol}`);
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
    .filter((b) => !b.asset.startsWith(LD_PREFIX) && b.free > 0)
    .map((b) => {
      const route = pickRoute(b.asset, coinConfig);
      const symbol = `${b.asset}USDT`;
      const price = usdPrice(b.asset, prices);
      return { ...b, symbol, usd: b.free * price, price, route };
    })
    .filter((c) => c.route.action === 'sell-to-usdt')
    .sort((a, b) => b.usd - a.usd);

  if (!candidates.length) {
    console.log('No spot assets to sell.');
    return;
  }

  for (const c of candidates) {
    const filters = await getExchangeFilters(c.symbol);
    if (!filters || filters.status !== 'TRADING') {
      console.log(`Skip ${c.asset}: no ${c.symbol} market (${formatUsd(c.usd)})`);
      continue;
    }
    const qty = floorToStep(c.free, filters.stepSize);
    const notional = qty * (c.price || 0);
    if (qty < filters.minQty || (filters.minNotional && notional < filters.minNotional)) {
      console.log(
        `Skip ${c.asset}: below min size/notional (have ${formatAmount(c.free)}, ~${formatUsd(c.usd)})`
      );
      continue;
    }

    console.log(`Sell ${formatAmount(qty)} ${c.asset} → USDT  (~${formatUsd(notional)})`);
    if (!FLAG_CONFIRM) continue;

    try {
      const order = await signedRequest('POST', '/api/v3/order', {
        symbol: c.symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: String(qty),
      });
      console.log('  Order:', order.orderId, order.status, 'executedQty=', order.executedQty);
    } catch (err) {
      console.log(`  Sell failed for ${c.asset}:`, err.message || err);
    }
  }

  if (!FLAG_CONFIRM) {
    console.log('Sells not sent (dry-run). Re-run with --sell-to-usdt --confirm');
  }
}

function pickNetwork(networks, wanted) {
  const want = String(wanted).toUpperCase();
  return networks.find((n) => {
    const net = String(n.network || '').toUpperCase();
    const name = String(n.name || '').toUpperCase();
    if (net === want) return true;
    if (want === 'BSC') return net === 'BSC' || name.includes('BEP20') || name.includes('BNB SMART CHAIN');
    if (want === 'ETH') return net === 'ETH' || net === 'ERC20' || name.includes('ERC20') || name.includes('ETHEREUM');
    if (want === 'NEAR') return net === 'NEAR' || name.includes('NEAR');
    return false;
  });
}

async function withdrawCoin({ coin, address, networkHint }) {
  const [balances, coinConfig] = await Promise.all([
    getAccountBalances(),
    signedRequest('GET', '/sapi/v1/capital/config/getall'),
  ]);
  const bal = balances.find((b) => b.asset === coin);
  const free = bal ? bal.free : 0;
  const cfg = (coinConfig || []).find((c) => c.coin === coin);
  const networks = (cfg && cfg.networkList) || [];
  const net = pickNetwork(networks, networkHint);

  console.log(`\n${coin} free balance:`, formatAmount(free));
  console.log('Requested network:', networkHint);
  if (networks.length) {
    console.log(`Available ${coin} networks:`);
    for (const n of networks) {
      if (!n.withdrawEnable) continue;
      console.log(
        `  ${n.network.padEnd(16)} fee=${n.withdrawFee}  min=${n.withdrawMin}  ${n.name || ''}`
      );
    }
  }

  if (!net) {
    throw new Error(`${coin} network ${networkHint} not found on this account. Pick one from the list.`);
  }
  if (!net.withdrawEnable) {
    throw new Error(`${coin} withdrawals disabled on ${net.network}`);
  }

  const fee = Number(net.withdrawFee || 0);
  const min = Number(net.withdrawMin || 0);
  const amount = Math.max(0, free - fee);
  console.log(
    `\nPlan: withdraw ${formatAmount(amount)} ${coin} on ${net.network} (fee ${fee}, min ${min})`
  );
  console.log('To:', address);

  if (amount < min || amount <= 0) {
    console.log(
      `Skip ${coin}: ${formatAmount(free)} is below min/fee for ${net.network} (min ${min}, fee ${fee}).`
    );
    return;
  }

  if (!FLAG_CONFIRM) {
    console.log(`Withdraw not sent (dry-run). Re-run with --withdraw --confirm`);
    return;
  }

  const result = await signedRequest('POST', '/sapi/v1/capital/withdraw/apply', {
    coin,
    address,
    amount: String(amount),
    network: net.network,
    walletType: 0,
  });
  console.log('Withdraw submitted:', JSON.stringify(result));
}

async function withdrawAssets(coinConfig) {
  if (!/^[0-9a-f]{64}$/i.test(NEAR_ADDRESS)) {
    throw new Error('NEAR_ADDRESS must be a 64-character hex implicit account (no 0x prefix).');
  }

  const balances = await getAccountBalances();
  const jobs = [];
  for (const b of balances) {
    if (b.asset.startsWith(LD_PREFIX) || b.free <= 0) continue;
    const route = pickRoute(b.asset, coinConfig);
    if (route.action !== 'withdraw') continue;
    jobs.push({ coin: b.asset, address: route.address, networkHint: route.networkHint });
  }

  if (!jobs.length) {
    console.log('No withdrawable coins found.');
    return;
  }

  for (const job of jobs) {
    try {
      await withdrawCoin(job);
    } catch (err) {
      console.log(`Skip ${job.coin}:`, err.message || err);
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
    console.error(
      'Set API_KEY and API_SECRET in withdraw-assets.js or BINANCE_API_KEY / BINANCE_API_SECRET.'
    );
    process.exit(1);
  }
}

async function main() {
  requireKeys();

  console.log('Fetching balances, prices, permissions, and coin networks...');
  const [prices, balances, coinConfig, perm] = await Promise.all([
    getPrices(),
    getAccountBalances(),
    signedRequest('GET', '/sapi/v1/capital/config/getall').catch((err) => {
      console.log('Coin network list unavailable:', err.message);
      return [];
    }),
    getApiRestrictions(),
  ]);
  printPermissions(perm);
  const { rows } = await printValuation(balances, prices);
  printPlan(rows, coinConfig);

  const mutating = FLAG_REDEEM || FLAG_SELL || FLAG_WITHDRAW;
  if (!mutating) return;

  if (FLAG_CONFIRM) {
    console.log('\n*** LIVE MODE: actions will be sent to Binance ***');
    console.log('NEAR address:', NEAR_ADDRESS);
    console.log('EVM address:', EVM_ADDRESS);
    console.log('USDT network:', USDT_NETWORK);
    await sleep(3000);
  } else {
    console.log('\n*** DRY RUN (no funds moved). Add --confirm to execute. ***');
  }

  if (FLAG_REDEEM) {
    try {
      await redeemEarn();
    } catch (err) {
      console.log('Redeem step failed:', err.message || err);
    }
    if (FLAG_CONFIRM) {
      console.log('Waiting 5s for redeem to settle...');
      await sleep(5000);
    }
  }

  if (FLAG_SELL) {
    try {
      const fresh = FLAG_CONFIRM ? await getAccountBalances() : balances;
      await sellToUsdt(fresh, prices, coinConfig);
    } catch (err) {
      console.log('Sell step failed:', err.message || err);
    }
    if (FLAG_CONFIRM) {
      console.log('Waiting 3s for sells to settle...');
      await sleep(3000);
    }
  }

  if (FLAG_WITHDRAW) {
    try {
      await withdrawAssets(coinConfig);
    } catch (err) {
      console.log('Withdraw step failed:', err.message || err);
    }
  }
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  process.exit(1);
});
