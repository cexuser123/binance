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
 * Why this does not send every coin to the 0x address:
 *   LD* balances are Simple Earn, not withdrawable coins.
 *   NEAR / LUNA / BTC / SOLO use non-EVM addresses. Sending them to 0x can lose funds.
 *   The only safe way to get everything to one 0x wallet is redeem → sell to USDT → withdraw USDT.
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || 'YOUR_API_KEY_HERE';
const API_SECRET = process.env.BINANCE_API_SECRET || 'YOUR_SECRET_KEY_HERE';
const WITHDRAW_ADDRESS =
  process.env.WITHDRAW_ADDRESS || '0x8fFE47791c35Bc7995aA899Be07a42a4Eb3F8701';
// BEP20 (BSC) is cheap and uses the same 0x address. Add BNB Smart Chain in MetaMask first.
// Use 'ETH' if you only want Ethereum mainnet (higher fee).
const USDT_NETWORK = process.env.USDT_NETWORK || 'BSC';
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

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function toQuery(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

function request(method, path, query = '') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: query ? `${path}?${query}` : path,
      method,
      headers: { 'X-MBX-APIKEY': API_KEY },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400 || (json.code && json.code < 0)) {
            reject(new Error(json.msg || data || `HTTP ${res.statusCode}`));
          } else {
            resolve(json);
          }
        } catch (err) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function signedRequest(method, path, params = {}) {
  const timestamp = await getServerTime();
  const query = toQuery({ ...params, timestamp, recvWindow: RECV_WINDOW });
  const signature = sign(query, API_SECRET);
  return request(method, path, `${query}&signature=${signature}`);
}

function publicGet(path, query = '') {
  return request('GET', path, query);
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

function printPlan(rows) {
  console.log('\n=== Withdrawal plan to', WITHDRAW_ADDRESS, '===\n');
  console.log('This address is an EVM 0x address (Ethereum / BSC / Polygon / Flare / Sonic).');
  console.log('It is NOT valid for native BTC, NEAR, LUNA, or SOLO (XRP ledger).\n');

  console.log('Recommended path:');
  console.log('  1. Redeem Simple Earn (LD*) back to spot.');
  console.log('  2. Market-sell tradeable coins to USDT (INJ, NEAR, S, and anything above min notional).');
  console.log('  3. Withdraw USDT on', USDT_NETWORK, 'to the 0x address.');
  console.log('     If using BSC, add BNB Smart Chain in MetaMask before you withdraw.');
  console.log('  4. Dust (under ~$5) usually cannot be sold or withdrawn.\n');

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

async function redeemEarn() {
  const positions = await getEarnPositions();
  if (!positions.length) {
    console.log('No Simple Earn flexible positions found.');
    return;
  }

  console.log(`\nFound ${positions.length} Simple Earn position(s).`);
  for (const p of positions) {
    const asset = p.asset || p.productId;
    const amount = p.totalAmount || p.latestAmount || p.amount;
    console.log(`  ${asset}  productId=${p.productId}  amount=${amount}`);
    if (!FLAG_CONFIRM) continue;
    if (!p.productId) continue;
    const result = await signedRequest('POST', '/sapi/v1/simple-earn/flexible/redeem', {
      productId: p.productId,
      redeemAll: 'true',
      destAccount: 'SPOT',
    });
    console.log('  Redeemed:', JSON.stringify(result));
  }

  if (!FLAG_CONFIRM) {
    console.log('Redeem not sent (dry-run). Re-run with --redeem --confirm');
  }
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

async function sellToUsdt(balances, prices) {
  const skip = new Set(['USDT']);
  const candidates = balances
    .filter((b) => !b.asset.startsWith(LD_PREFIX) && !skip.has(b.asset) && b.free > 0)
    .map((b) => {
      const symbol = `${b.asset}USDT`;
      const price = usdPrice(b.asset, prices);
      return { ...b, symbol, usd: b.free * price, price };
    })
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

    const order = await signedRequest('POST', '/api/v3/order', {
      symbol: c.symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: String(qty),
    });
    console.log('  Order:', order.orderId, order.status, 'executedQty=', order.executedQty);
  }

  if (!FLAG_CONFIRM) {
    console.log('Sells not sent (dry-run). Re-run with --sell-to-usdt --confirm');
  }
}

async function withdrawUsdt() {
  const [balances, coinConfig] = await Promise.all([
    getAccountBalances(),
    signedRequest('GET', '/sapi/v1/capital/config/getall'),
  ]);
  const usdt = balances.find((b) => b.asset === 'USDT');
  const free = usdt ? usdt.free : 0;
  const coin = (coinConfig || []).find((c) => c.coin === 'USDT');
  const networks = (coin && coin.networkList) || [];
  const net = networks.find(
    (n) =>
      n.network === USDT_NETWORK ||
      n.network === `USDT${USDT_NETWORK}` ||
      (USDT_NETWORK === 'BSC' && (n.network === 'BSC' || n.name === 'BNB Smart Chain (BEP20)')) ||
      (USDT_NETWORK === 'ETH' && (n.network === 'ETH' || n.network === 'ERC20'))
  );

  console.log('\nUSDT free balance:', formatAmount(free));
  console.log('Requested network:', USDT_NETWORK);
  if (networks.length) {
    console.log('Available USDT networks:');
    for (const n of networks) {
      if (!n.withdrawEnable) continue;
      console.log(
        `  ${n.network.padEnd(16)} fee=${n.withdrawFee}  min=${n.withdrawMin}  ${n.name || ''}`
      );
    }
  }

  if (!net) {
    throw new Error(`USDT network ${USDT_NETWORK} not found on this account. Pick one from the list.`);
  }
  if (!net.withdrawEnable) {
    throw new Error(`USDT withdrawals disabled on ${net.network}`);
  }

  const fee = Number(net.withdrawFee || 0);
  const min = Number(net.withdrawMin || 0);
  const amount = Math.max(0, free - fee);
  console.log(
    `\nPlan: withdraw ${formatAmount(amount)} USDT on ${net.network} (fee ${fee}, min ${min})`
  );
  console.log('To:', WITHDRAW_ADDRESS);

  if (amount < min || amount <= 0) {
    throw new Error(
      `USDT amount ${formatAmount(free)} is below min/fee for ${net.network} (min ${min}, fee ${fee}).`
    );
  }

  if (!FLAG_CONFIRM) {
    console.log('Withdraw not sent (dry-run). Re-run with --withdraw --confirm');
    return;
  }

  const result = await signedRequest('POST', '/sapi/v1/capital/withdraw/apply', {
    coin: 'USDT',
    address: WITHDRAW_ADDRESS,
    amount: String(amount),
    network: net.network,
    walletType: 0,
  });
  console.log('Withdraw submitted:', JSON.stringify(result));
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

  console.log('Fetching balances and prices...');
  const [prices, balances] = await Promise.all([getPrices(), getAccountBalances()]);
  const { rows } = await printValuation(balances, prices);
  printPlan(rows);

  const mutating = FLAG_REDEEM || FLAG_SELL || FLAG_WITHDRAW;
  if (!mutating) return;

  if (FLAG_CONFIRM) {
    console.log('\n*** LIVE MODE: actions will be sent to Binance ***');
    console.log('Address:', WITHDRAW_ADDRESS);
    console.log('USDT network:', USDT_NETWORK);
    await sleep(3000);
  } else {
    console.log('\n*** DRY RUN (no funds moved). Add --confirm to execute. ***');
  }

  if (FLAG_REDEEM) {
    await redeemEarn();
    if (FLAG_CONFIRM) {
      console.log('Waiting 5s for redeem to settle...');
      await sleep(5000);
    }
  }

  if (FLAG_SELL) {
    const fresh = FLAG_CONFIRM ? await getAccountBalances() : balances;
    await sellToUsdt(fresh, prices);
    if (FLAG_CONFIRM) {
      console.log('Waiting 3s for sells to settle...');
      await sleep(3000);
    }
  }

  if (FLAG_WITHDRAW) {
    await withdrawUsdt();
  }
}

main().catch((err) => {
  console.error('\nFailed:', err.message || err);
  process.exit(1);
});
