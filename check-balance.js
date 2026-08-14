/**
 * Binance account snapshot: all balances + USD + destination addresses
 *
 * Usage:
 *   Set BINANCE_API_KEY / BINANCE_API_SECRET (or edit CONFIG below)
 *   node check-balance.js
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || 'YOUR_API_KEY_HERE';
const API_SECRET = process.env.BINANCE_API_SECRET || 'YOUR_SECRET_KEY_HERE';
const EVM_ADDRESS =
  process.env.WITHDRAW_ADDRESS || '0x8fFE47791c35Bc7995aA899Be07a42a4Eb3F8701';
const NEAR_ADDRESS =
  process.env.NEAR_ADDRESS ||
  '50d977e40268ede1640f9c49c4a7656f447d82399b3554bda1e5a10c60db5416';
const USDT_NETWORK = process.env.USDT_NETWORK || 'BSC';
const BASE_URL = 'api.binance.com';
const RECV_WINDOW = 60000;
// ============================

const LD_PREFIX = 'LD';
const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);
const FALLBACK_USD = { SOLO: 0.01262, FLR: 0.00598, SUSD: 0.67 };
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

async function getServerTime() {
  const data = await request('GET', '/api/v3/time');
  return data.serverTime;
}

async function signedRequest(method, path, params = {}) {
  const timestamp = await getServerTime();
  const query = toQuery({ ...params, timestamp, recvWindow: RECV_WINDOW });
  return request(method, path, `${query}&signature=${sign(query, API_SECRET)}`);
}

function formatAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `$${n.toFixed(2)}`;
}

function underlyingAsset(asset) {
  return asset.startsWith(LD_PREFIX) && asset.length > 2 ? asset.slice(2) : asset;
}

function usdPrice(asset, prices) {
  if (STABLE.has(asset)) return asset === 'USDT' ? 1 : prices[`${asset}USDT`] || 1;
  const p = prices[`${asset}USDT`];
  if (p && p > 0) return p;
  return FALLBACK_USD[asset] || 0;
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
    return { action: 'withdraw', network: 'NEAR', address: NEAR_ADDRESS };
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
    return { action: 'withdraw', network: picked.network, address: EVM_ADDRESS, fee: picked.withdrawFee, min: picked.withdrawMin };
  }
  return { action: 'sell-to-usdt', network: '-', address: '-' };
}

async function main() {
  if (
    !API_KEY ||
    !API_SECRET ||
    API_KEY.includes('YOUR_API_KEY') ||
    API_SECRET.includes('YOUR_SECRET_KEY')
  ) {
    console.error('Set API_KEY and API_SECRET in check-balance.js or via env vars.');
    process.exit(1);
  }

  console.log('Fetching balances, earn positions, prices, and coin networks...\n');

  const [account, earn, tickers, coinConfig] = await Promise.all([
    signedRequest('GET', '/api/v3/account'),
    signedRequest('GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 }).catch(() => ({
      rows: [],
    })),
    request('GET', '/api/v3/ticker/price'),
    signedRequest('GET', '/sapi/v1/capital/config/getall').catch(() => []),
  ]);

  const prices = {};
  for (const t of tickers) prices[t.symbol] = Number(t.price);

  const spot = (account.balances || [])
    .map((b) => ({
      source: 'SPOT',
      asset: b.asset,
      free: Number(b.free),
      locked: Number(b.locked),
      total: Number(b.free) + Number(b.locked),
    }))
    .filter((b) => b.total > 0);

  const earnRows = (earn.rows || earn || []).map((p) => ({
    source: 'EARN',
    asset: `LD${p.asset || ''}`.replace(/^LDLD/, 'LD'),
    base: p.asset,
    free: Number(p.totalAmount || p.latestAmount || 0),
    locked: 0,
    total: Number(p.totalAmount || p.latestAmount || 0),
    productId: p.productId,
  })).filter((b) => b.total > 0);

  const byAsset = new Map();
  for (const row of [...spot, ...earnRows]) {
    const key = `${row.source}:${row.asset}`;
    const prev = byAsset.get(key);
    if (prev) prev.total += row.total;
    else byAsset.set(key, { ...row });
  }
  const rows = [...byAsset.values()].sort((a, b) => b.total - a.total);

  console.log('Destination wallets:');
  console.log('  EVM :', EVM_ADDRESS);
  console.log('  NEAR:', NEAR_ADDRESS);
  console.log('');
  console.log(
    'Source'.padEnd(8),
    'Asset'.padEnd(12),
    'Amount'.padStart(16),
    'USD'.padStart(12),
    'Route'.padEnd(14),
    'Network'.padEnd(12),
    'Address'
  );
  console.log('-'.repeat(120));

  let totalUsd = 0;
  for (const row of rows) {
    const base = row.base || underlyingAsset(row.asset);
    const price = usdPrice(base, prices);
    const usd = row.total * price;
    totalUsd += usd;
    const route = pickRoute(base, coinConfig);
    console.log(
      row.source.padEnd(8),
      row.asset.padEnd(12),
      formatAmount(row.total).padStart(16),
      formatUsd(usd).padStart(12),
      route.action.padEnd(14),
      String(route.network).padEnd(12),
      route.address
    );
  }

  console.log('-'.repeat(120));
  console.log('TOTAL USD'.padEnd(8), ''.padEnd(12), ''.padStart(16), formatUsd(totalUsd).padStart(12));
  console.log('\nCan trade:', account.canTrade, '| Can withdraw:', account.canWithdraw, '| Can deposit:', account.canDeposit);
  console.log('sell-to-usdt = coin cannot go to your EVM/NEAR address (BTC, LUNA, SOLO, etc.).');
}

main().catch((err) => {
  console.error('Balance check failed:', err.message || err);
  process.exit(1);
});
