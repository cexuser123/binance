/**
 * Binance Spot Balance Checker (single file, no npm dependencies)
 *
 * Usage:
 *   1. Set your keys below OR via environment variables:
 *        BINANCE_API_KEY / BINANCE_API_SECRET
 *   2. node check-balance.js
 */

const crypto = require('crypto');
const https = require('https');

// ========== CONFIG ==========
const API_KEY = process.env.BINANCE_API_KEY || 'YOUR_API_KEY_HERE';
const API_SECRET = process.env.BINANCE_API_SECRET || 'YOUR_SECRET_KEY_HERE';
const BASE_URL = 'api.binance.com'; // use 'testnet.binance.vision' for testnet
const RECV_WINDOW = 5000;
// ============================

function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function request(method, path, query = '') {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE_URL,
      path: query ? `${path}?${query}` : path,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400 || json.code) {
            reject(new Error(json.msg || data));
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

async function getAccount() {
  const timestamp = await getServerTime();
  const query = `timestamp=${timestamp}&recvWindow=${RECV_WINDOW}`;
  const signature = sign(query, API_SECRET);
  return request('GET', '/api/v3/account', `${query}&signature=${signature}`);
}

function formatAmount(value) {
  const n = parseFloat(value);
  if (Number.isNaN(n)) return value;
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}

async function main() {
  if (
    !API_KEY ||
    !API_SECRET ||
    API_KEY.includes('YOUR_API_KEY') ||
    API_SECRET.includes('YOUR_SECRET_KEY')
  ) {
    console.error(
      'Please set API_KEY and API_SECRET in check-balance.js or via BINANCE_API_KEY / BINANCE_API_SECRET env vars.'
    );
    process.exit(1);
  }

  console.log('Fetching Binance spot account balances...\n');

  const account = await getAccount();
  const balances = (account.balances || []).filter((b) => {
    return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0;
  });

  if (balances.length === 0) {
    console.log('No non-zero balances found.');
    return;
  }

  console.log('Asset'.padEnd(12), 'Free'.padStart(18), 'Locked'.padStart(18), 'Total'.padStart(18));
  console.log('-'.repeat(66));

  for (const b of balances) {
    const free = parseFloat(b.free);
    const locked = parseFloat(b.locked);
    const total = free + locked;
    console.log(
      b.asset.padEnd(12),
      formatAmount(free).padStart(18),
      formatAmount(locked).padStart(18),
      formatAmount(total).padStart(18)
    );
  }

  console.log('\nAccount type:', account.accountType || 'N/A');
  console.log('Can trade:', account.canTrade);
  console.log('Can withdraw:', account.canWithdraw);
  console.log('Can deposit:', account.canDeposit);
}

main().catch((err) => {
  console.error('Balance check failed:', err.message || err);
  process.exit(1);
});
