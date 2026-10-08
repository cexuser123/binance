/**
 * Binance balance + deposit address checker (single file, no npm deps)
 *
 * Prints:
 *   - Spot / Funding / Earn balances with USD
 *   - Deposit addresses for every network of each coin you hold
 *
 * Usage:
 *   Set BINANCE_API_KEY / BINANCE_API_SECRET (or edit CONFIG below)
 *   node check-balance.js
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || 'RkWiIbbe0JDQeqFiX20VVho0xZUe31vhoXbel0K4QxbBE9XdbVoUq0DCr3WJoRks';
const API_SECRET = process.env.BINANCE_API_SECRET || 'MnVDz9tZOANJfUrGTBpQG9cgrzrozvRLxl1McwnvWCf6FNXrbpXP4QrWXKiPIGxG';
const BASE_URL = 'api.binance.com';
const RECV_WINDOW = 60000;
const ADDRESS_DELAY_MS = 200; // avoid rate limits when fetching addresses
// ============================

const LD_PREFIX = 'LD';
const STABLE = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'DAI']);
const FALLBACK_USD = { SOLO: 0.01262, FLR: 0.00598, SUSD: 0.67 };

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

function printTable(title, rows, prices) {
  console.log(`\n=== ${title} ===\n`);
  if (!rows.length) {
    console.log('(empty)');
    return 0;
  }

  console.log(
    'Asset'.padEnd(12),
    'Free'.padStart(16),
    'Locked'.padStart(16),
    'Total'.padStart(16),
    'USD'.padStart(12),
    'Note'
  );
  console.log('-'.repeat(90));

  let totalUsd = 0;
  for (const row of rows) {
    const base = row.base || underlyingAsset(row.asset);
    const price = usdPrice(base, prices);
    const usd = row.total * price;
    totalUsd += usd;
    console.log(
      row.asset.padEnd(12),
      formatAmount(row.free).padStart(16),
      formatAmount(row.locked).padStart(16),
      formatAmount(row.total).padStart(16),
      formatUsd(usd).padStart(12),
      ' ' + (row.note || '')
    );
  }
  console.log('-'.repeat(90));
  console.log('TOTAL USD'.padEnd(12), ''.padStart(16), ''.padStart(16), ''.padStart(16), formatUsd(totalUsd).padStart(12));
  return totalUsd;
}

async function getDepositAddress(coin, network) {
  try {
    const params = { coin };
    if (network) params.network = network;
    return await signedRequest('GET', '/sapi/v1/capital/deposit/address', params);
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function printDepositAddresses(coinsWithBalance, coinConfig) {
  console.log('\n=== Deposit addresses by chain (for coins you hold) ===\n');
  console.log('These are Binance DEPOSIT addresses (receive into Binance).');
  console.log('They are NOT your personal MetaMask / NEAR wallet addresses.\n');

  const byCoin = new Map();
  for (const row of coinsWithBalance) {
    const coin = underlyingAsset(row.asset);
    if (!byCoin.has(coin)) byCoin.set(coin, 0);
    byCoin.set(coin, byCoin.get(coin) + row.total);
  }

  if (!byCoin.size) {
    console.log('No coins with balance — skipping address lookup.');
    return;
  }

  for (const [coin, amount] of byCoin) {
    const cfg = (coinConfig || []).find((c) => c.coin === coin);
    const networks = ((cfg && cfg.networkList) || []).filter((n) => n.depositEnable);
    console.log(`\n${coin}  (balance ~ ${formatAmount(amount)})`);
    if (!networks.length) {
      console.log('  No deposit-enabled networks found in capital config.');
      // still try default address
      const addr = await getDepositAddress(coin);
      if (addr.address) {
        console.log(`  DEFAULT  address=${addr.address}${addr.tag ? `  tag/memo=${addr.tag}` : ''}`);
      } else {
        console.log(`  ${addr.error || 'unavailable'}`);
      }
      await sleep(ADDRESS_DELAY_MS);
      continue;
    }

    for (const n of networks) {
      const addr = await getDepositAddress(coin, n.network);
      if (addr.address) {
        const tag = addr.tag ? `  tag/memo=${addr.tag}` : '';
        console.log(
          `  ${(n.network || '').padEnd(14)} ${String(n.name || '').padEnd(28)} address=${addr.address}${tag}`
        );
      } else {
        console.log(
          `  ${(n.network || '').padEnd(14)} ${String(n.name || '').padEnd(28)} ERROR: ${addr.error || 'no address'}`
        );
      }
      await sleep(ADDRESS_DELAY_MS);
    }
  }
}

async function main() {
  if (
    !API_KEY ||
    !API_SECRET ||
    API_KEY.includes('YOUR_API_KEY') ||
    API_SECRET.includes('YOUR_SECRET_KEY')
  ) {
    console.error(
      'Set API_KEY and API_SECRET in check-balance.js or via BINANCE_API_KEY / BINANCE_API_SECRET.'
    );
    process.exit(1);
  }

  console.log('Fetching Binance balances, wallets, and deposit addresses...\n');

  const [account, earn, tickers, coinConfig, funding, walletBal] = await Promise.all([
    signedRequest('GET', '/api/v3/account').catch((err) => {
      console.log('Spot account error:', err.message);
      return { balances: [] };
    }),
    signedRequest('GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 }).catch((err) => {
      console.log('Simple Earn error:', err.message);
      return { rows: [] };
    }),
    request('GET', '/api/v3/ticker/price').catch(() => []),
    signedRequest('GET', '/sapi/v1/capital/config/getall').catch((err) => {
      console.log('Capital config error:', err.message);
      return [];
    }),
    signedRequest('POST', '/sapi/v1/asset/get-funding-asset', {}).catch((err) => {
      console.log('Funding wallet error:', err.message);
      return [];
    }),
    signedRequest('GET', '/sapi/v1/asset/wallet/balance', { quoteAsset: 'USDT' }).catch((err) => {
      console.log('Wallet balance error:', err.message);
      return [];
    }),
  ]);

  const prices = {};
  for (const t of tickers || []) prices[t.symbol] = Number(t.price);

  // Spot
  const spot = (account.balances || [])
    .map((b) => ({
      asset: b.asset,
      free: Number(b.free),
      locked: Number(b.locked),
      total: Number(b.free) + Number(b.locked),
      note: b.asset.startsWith(LD_PREFIX) ? `Simple Earn ${underlyingAsset(b.asset)}` : '',
    }))
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total * usdPrice(underlyingAsset(b.asset), prices) - a.total * usdPrice(underlyingAsset(a.asset), prices));

  // Capital config (wallet free/locked from all coins info)
  const capital = (coinConfig || [])
    .map((c) => {
      const free = Number(c.free || 0);
      const locked = Number(c.locked || 0);
      const freeze = Number(c.freeze || 0);
      const withdrawing = Number(c.withdrawing || 0);
      const total = free + locked + freeze + withdrawing;
      return {
        asset: c.coin,
        free,
        locked: locked + freeze + withdrawing,
        total,
        note: freeze || withdrawing ? `freeze=${formatAmount(freeze)} withdrawing=${formatAmount(withdrawing)}` : '',
      };
    })
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total * usdPrice(a.asset, prices) - a.total * usdPrice(b.asset, prices));

  // Funding
  const fundingRows = (Array.isArray(funding) ? funding : [])
    .map((f) => ({
      asset: f.asset,
      free: Number(f.free || 0),
      locked: Number(f.locked || 0) + Number(f.freeze || 0),
      total: Number(f.free || 0) + Number(f.locked || 0) + Number(f.freeze || 0),
      note: 'Funding wallet',
    }))
    .filter((b) => b.total > 0);

  // Earn API positions
  const earnRows = (earn.rows || earn || [])
    .map((p) => {
      const base = p.asset || '';
      const total = Number(p.totalAmount || p.latestAmount || 0);
      return {
        asset: `LD${base}`.replace(/^LDLD/, 'LD'),
        base,
        free: total,
        locked: 0,
        total,
        note: `productId=${p.productId || '-'}`,
      };
    })
    .filter((b) => b.total > 0);

  if (Array.isArray(walletBal) && walletBal.length) {
    console.log('=== Wallet overview (USDT) ===\n');
    for (const w of walletBal) {
      console.log(
        `  ${String(w.walletName || w.activateStatus || 'wallet').padEnd(20)} balance=${formatAmount(
          w.balance
        )}`
      );
    }
  }

  const spotUsd = printTable('SPOT balances', spot, prices);
  const capitalUsd = printTable('CAPITAL / wallet coin balances', capital, prices);
  const fundingUsd = printTable('FUNDING wallet', fundingRows, prices);
  const earnUsd = printTable('SIMPLE EARN flexible positions', earnRows, prices);

  const grand = spotUsd + fundingUsd + earnUsd;
  // capital often overlaps spot — do not double-count in grand total
  console.log('\n=== Combined total (Spot + Funding + Earn) ===');
  console.log(formatUsd(grand));
  if (capital.length && !spot.length && !earnRows.length && !fundingRows.length) {
    console.log('(Using capital balances only)');
    console.log(formatUsd(capitalUsd));
  }

  if (!spot.length && !capital.length && !fundingRows.length && !earnRows.length) {
    console.log('\nNo non-zero balances found in Spot / Capital / Funding / Earn.');
    console.log('Check that your API key has Enable Reading, and that keys are set correctly.');
  }

  // Deposit addresses for coins you actually hold
  const held = [...spot, ...capital, ...fundingRows, ...earnRows];
  await printDepositAddresses(held, coinConfig);

  console.log('\nAccount type:', account.accountType || 'N/A');
  console.log('Can trade:', account.canTrade);
  console.log('Can withdraw:', account.canWithdraw);
  console.log('Can deposit:', account.canDeposit);
}

main().catch((err) => {
  console.error('Balance check failed:', err.message || err);
  process.exit(1);
});
