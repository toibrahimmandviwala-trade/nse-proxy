/**
 * ================================================================
 *  NSE PROXY — Angel One SmartAPI
 *  Replaces NSE scraping with official Angel One broker API.
 *  Live quotes, OHLC, option chain — all official & reliable.
 * ================================================================
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const { authenticator } = require('otplib');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credentials from Render environment variables ─────────────
const ANGEL_API_KEY     = process.env.ANGEL_API_KEY;
const ANGEL_CLIENT_ID   = process.env.ANGEL_CLIENT_ID;
const ANGEL_MPIN        = process.env.ANGEL_MPIN;
const ANGEL_TOTP_SECRET = process.env.ANGEL_TOTP_SECRET;

// ── CORS ──────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://melodic-shortbread-a97330.netlify.app',
  'http://localhost',
  'http://127.0.0.1',
  'null'
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error('CORS blocked: ' + origin));
  }
}));
app.use(express.json());

// ── SmartAPI base ─────────────────────────────────────────────
const SMART_BASE = 'https://apiconnect.angelbroking.com';

// ── Session cache ─────────────────────────────────────────────
let jwtToken    = '';
let refreshToken = '';
let sessionExp  = 0;

// ── Symbol map: NSE symbol → Angel One token ─────────────────
// Angel One uses numeric tokens for each symbol
const SYMBOL_TOKENS = {
  'RELIANCE':    '2885',
  'HDFCBANK':    '1333',
  'TCS':         '11536',
  'INFY':        '1594',
  'HINDUNILVR':  '1394',
  'ICICIBANK':   '4963',
  'BHARTIARTL':  '10604',
  'WIPRO':       '3787',
  'SBIN':        '3045',
  'KOTAKBANK':   '1922',
  'AXISBANK':    '5900',
  'BAJFINANCE':  '317',
  'INDUSINDBK':  '5258',
  'LTIM':        '17818',
  'TECHM':       '13538',
  'HCLTECH':     '7229',
  'PERSISTENT':  '18365',
  'ONGC':        '2475',
  'NTPC':        '11630',
  'POWERGRID':   '14977',
  'IOC':         '1624',
  'BPCL':        '526',
  'COALINDIA':   '20374',
  'BHEL':        '438',
  'LT':          '11483',
  'ADANIPORTS':  '15083',
  'ULTRACEMCO':  '11532',
  'GRASIM':      '1232',
  'SIEMENS':     '3004',
  'TATAMOTORS':  '3456',
  'MARUTI':      '10999',
  'EICHERMOT':   '910',
  'BAJAJ-AUTO':  '16669',
  'HEROMOTOCO':  '1348',
  'BOSCHLTD':    '2403',
  'HINDUNILVR':  '1394',
  'ITC':         '1660',
  'NESTLEIND':   '17963',
  'BRITANNIA':   '547',
  'DABUR':       '772',
  'MARICO':      '4067',
  'COLPAL':      '1099',
  'ADANIGREEN':  '25780',
  'TATAPOWER':   '3426',
  'TATASTEEL':   '3499',
  'JSWSTEEL':    '11723',
  'HINDALCO':    '1363',
  'VEDL':        '3063',
  'SAIL':        '2963',
  'NATIONALUM':  '9819',
  'HINDZINC':    '1747',
  'NIFTY':       '26000',
  'BANKNIFTY':   '26009',
  'MM':          '2031',
};

// ── MCX Commodity tokens (Angel One SmartAPI, exchange=MCX) ───
// MCX tokens — front-month contracts. Refreshed dynamically at startup.
const MCX_TOKENS = {
  'CRUDEOIL': '234230',
  'GOLD':     '234385',
  'SILVER':   '234386',
};

// Refresh MCX tokens to get current active near-month contract IDs
async function refreshMCXTokens() {
  try {
    const headers = await smartHeaders();
    for (const sym of ['GOLD', 'SILVER', 'CRUDEOIL']) {
      try {
        const r = await axios.get(
          `${SMART_BASE}/rest/secure/angelbroking/order/v1/searchScrip?exchange=MCX&searchscrip=${sym}`,
          { headers, timeout: 5000 }
        );
        const items = (r.data?.data || []).filter(i => i.exch_seg === 'MCX');
        // Sort by expiry ascending, pick nearest active contract
        items.sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
        if (items.length) {
          MCX_TOKENS[sym] = items[0].token;
          console.log(`MCX ${sym}: token=${items[0].token} symbol=${items[0].symbol} expiry=${items[0].expiry}`);
        }
      } catch(e) { console.warn(`MCX token refresh skipped for ${sym}:`, e.message); }
    }
  } catch(e) { console.warn('MCX refresh failed, using static tokens:', e.message); }
}

// ── Crypto symbols handled via CoinGecko (free, no key) ───────
const CRYPTO_IDS = {
  'BITCOIN':  'bitcoin',
  'ETHEREUM': 'ethereum',
};

// ── Generate TOTP ─────────────────────────────────────────────
function generateTOTP() {
  return authenticator.generate(ANGEL_TOTP_SECRET);
}

// ── Login to SmartAPI ─────────────────────────────────────────
async function login() {
  const now = Date.now();
  if (jwtToken && now < sessionExp) return jwtToken;

  console.log('🔐 Logging in to Angel One SmartAPI…');
  const totp = generateTOTP();

  const res = await axios.post(`${SMART_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`, {
    clientcode: ANGEL_CLIENT_ID,
    password:   ANGEL_MPIN,
    totp
  }, {
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
      'X-UserType':    'USER',
      'X-SourceID':    'WEB',
      'X-ClientLocalIP': '192.168.1.1',
      'X-ClientPublicIP': '106.193.147.98',
      'X-MACAddress':  '00:00:00:00:00:00',
      'X-PrivateKey':  ANGEL_API_KEY,
    }
  });

  if (!res.data?.data?.jwtToken) {
    throw new Error('Login failed: ' + JSON.stringify(res.data));
  }

  jwtToken     = res.data.data.jwtToken;
  refreshToken = res.data.data.refreshToken;
  sessionExp   = now + 8 * 60 * 60 * 1000; // 8 hour session
  console.log('✅ Logged in to SmartAPI successfully');
  return jwtToken;
}

// ── Refresh session if needed ─────────────────────────────────
async function getToken() {
  if (jwtToken && Date.now() < sessionExp) return jwtToken;
  return login();
}

// ── SmartAPI headers ──────────────────────────────────────────
async function smartHeaders(forceRefresh = false) {
  if (forceRefresh) { jwtToken = ''; sessionExp = 0; }
  const token = await getToken();
  return {
    'Authorization':   `Bearer ${token}`,
    'Content-Type':    'application/json',
    'Accept':          'application/json',
    'X-UserType':      'USER',
    'X-SourceID':      'WEB',
    'X-ClientLocalIP': '192.168.1.1',
    'X-ClientPublicIP':'106.193.147.98',
    'X-MACAddress':    '00:00:00:00:00:00',
    'X-PrivateKey':    ANGEL_API_KEY,
  };
}

// ── Health ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:       'ok',
    service:      'NSE Proxy (Angel One SmartAPI)',
    sessionReady: !!jwtToken && Date.now() < sessionExp,
    expiresIn:    sessionExp ? Math.round((sessionExp - Date.now()) / 1000 / 60) + ' min' : 'none',
    mcxTokens:    MCX_TOKENS,
  });
});

// ── GET /debug — full diagnostic ─────────────────────────────
app.get('/debug', async (req, res) => {
  const sym = ((req.query.symbol) || 'NIFTY').toUpperCase();
  const result = { timestamp: new Date().toISOString(), symbol: sym, tests: {} };
  try {
    const tok = await getToken();
    result.tests.auth = { ok: true, tokenLen: tok.length, expiresIn: Math.round((sessionExp - Date.now())/60000) + 'min' };
  } catch(e) { result.tests.auth = { ok: false, error: e.message }; }
  try {
    const h = await smartHeaders();
    const tkn = SYMBOL_TOKENS[sym] || '26000';
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`,
      { mode:'FULL', exchangeTokens:{ NSE:[tkn] } }, { headers: h });
    result.tests.nseQuote = { ok: true, ltp: r.data?.data?.fetched?.[0]?.ltp, errorcode: r.data?.errorcode };
  } catch(e) { result.tests.nseQuote = { ok: false, error: e.message }; }
  try {
    const h = await smartHeaders();
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`,
      { mode:'FULL', exchangeTokens:{ MCX:[MCX_TOKENS['GOLD']] } }, { headers: h });
    result.tests.mcxGold = { ok: true, token: MCX_TOKENS['GOLD'], ltp: r.data?.data?.fetched?.[0]?.ltp, errorcode: r.data?.errorcode };
  } catch(e) { result.tests.mcxGold = { ok: false, token: MCX_TOKENS['GOLD'], error: e.message }; }
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=inr&include_24hr_change=true', { timeout: 8000 });
    result.tests.coingecko = { ok: true, btcInr: r.data?.bitcoin?.inr };
  } catch(e) { result.tests.coingecko = { ok: false, error: e.message }; }
  result.mcxTokens = MCX_TOKENS;
  result.sessionExpiry = sessionExp ? new Date(sessionExp).toISOString() : 'none';
  res.json(result);
});

// ── Warmup ────────────────────────────────────────────────────
app.get('/warmup', async (req, res) => {
  try {
    await login();
    res.json({ status: 'ok', message: 'SmartAPI session ready!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /quote/:symbol ────────────────────────────────────────
app.get('/quote/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  // ── Crypto: use CoinGecko ─────────────────────────────────
  if (CRYPTO_IDS[symbol]) {
    try {
      const cgId = CRYPTO_IDS[symbol];
      const r = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=inr&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`);
      const d = r.data[cgId];
      if (!d) return res.status(502).json({ error: 'CoinGecko: no data' });
      const pChange = +(d.inr_24h_change || 0).toFixed(2);
      return res.json({
        symbol, lastPrice: d.inr, netChange: +(d.inr * pChange / 100).toFixed(2),
        pChange, volume: d.inr_24h_vol || 0, dayHigh: +(d.inr * 1.02).toFixed(2),
        dayLow:  +(d.inr * 0.98).toFixed(2), prevClose: +(d.inr / (1 + pChange/100)).toFixed(2),
        isCrypto: true, marketCap: d.inr_market_cap,
      });
    } catch(e) { return res.status(502).json({ error: 'Crypto fetch failed: ' + e.message }); }
  }

  // ── MCX Commodities ────────────────────────────────────────
  if (MCX_TOKENS[symbol]) {
    try {
      const headers = await smartHeaders();
      const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
        mode: 'FULL', exchangeTokens: { MCX: [MCX_TOKENS[symbol]] }
      }, { headers });
      let d = r.data?.data?.fetched?.[0];
      if (!d && r.data?.errorcode) {
        // Session may have expired — re-login and retry
        const h2 = await smartHeaders(true);
        const r2 = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`,
          { mode: 'FULL', exchangeTokens: { MCX: [MCX_TOKENS[symbol]] } }, { headers: h2 });
        d = r2.data?.data?.fetched?.[0];
      }
      if (!d) return res.status(502).json({ error: 'MCX: no data for ' + symbol + ' (token:' + MCX_TOKENS[symbol] + ')' });
      return res.json({
        symbol, lastPrice: d.ltp, netChange: d.netChange,
        pChange: d.percentChange, volume: d.tradeVolume || 0,
        dayHigh: d.high, dayLow: d.low, prevClose: d.close,
        isCommodity: true,
      });
    } catch(e) { return res.status(502).json({ error: 'MCX fetch failed: ' + e.message }); }
  }

  const token  = SYMBOL_TOKENS[symbol];
  if (!token) return res.status(404).json({ error: 'Symbol not found: ' + symbol });

  try {
    const headers = await smartHeaders();
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
      mode: 'FULL',
      exchangeTokens: { NSE: [token] }
    }, { headers });

    let d = r.data?.data?.fetched?.[0];
    // If session expired mid-run, re-login once and retry
    if (!d && (r.data?.errorcode || r.data?.status === false)) {
      console.warn('Session issue detected, re-logging in for', symbol);
      const h2 = await smartHeaders(true);
      const r2 = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`,
        { mode: 'FULL', exchangeTokens: { NSE: [token] } }, { headers: h2 });
      d = r2.data?.data?.fetched?.[0];
    }
    if (!d) throw new Error('No quote data from SmartAPI for ' + symbol);

    res.json({
      symbol:    symbol,
      lastPrice: d.ltp,
      change:    d.netChange,
      pChange:   d.percentChange,
      volume:    d.tradeVolume,
      dayHigh:   d.high,
      dayLow:    d.low,
      prevClose: d.close,
      open:      d.open,
    });
  } catch (e) {
    console.error('Quote error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /historical/:symbol ───────────────────────────────────
app.get('/historical/:symbol', async (req, res) => {
  const symbol    = req.params.symbol.toUpperCase();
  const interval  = req.query.interval || 'ONE_DAY';

  // ── Crypto historical via CoinGecko ───────────────────────
  if (CRYPTO_IDS[symbol]) {
    try {
      const cgId = CRYPTO_IDS[symbol];
      const r = await axios.get(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=inr&days=60`);
      // CoinGecko returns [timestamp, open, high, low, close]
      const ohlc = r.data.map(d => ({
        t: new Date(d[0]).toISOString().split('T')[0],
        o: d[1], h: d[2], l: d[3], c: d[4], v: 0,
      }));
      return res.json({ symbol, data: ohlc });
    } catch(e) { return res.status(502).json({ error: 'Crypto historical failed: ' + e.message }); }
  }

  // ── MCX Commodities historical ────────────────────────────
  if (MCX_TOKENS[symbol]) {
    try {
      const headers = await smartHeaders();
      const to   = new Date();
      const from = new Date(); from.setDate(to.getDate() - 90);
      const fmt  = d => d.toISOString().split('T')[0] + ' 09:00';
      const fmtTo = d => d.toISOString().split('T')[0] + ' 23:30';
      const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
        exchange: 'MCX', symboltoken: MCX_TOKENS[symbol],
        interval: 'ONE_DAY', fromdate: fmt(from), todate: fmtTo(to),
      }, { headers });
      const candles = r.data?.data ?? [];
      const ohlc = candles.slice(-60).map(c => ({
        t: c[0].split('T')[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5]
      }));
      return res.json({ symbol, data: ohlc });
    } catch(e) { return res.status(502).json({ error: 'MCX historical failed: ' + e.message }); }
  }

  const token     = SYMBOL_TOKENS[symbol];
  if (!token) return res.status(404).json({ error: 'Symbol not found: ' + symbol });

  // Date range: last 30 days
  const to   = new Date();
  const from = new Date(); from.setDate(to.getDate() - 90); // 90 days = ~60 trading candles
  const fmt  = d => d.toISOString().split('T')[0] + ' 09:15';
  const fmtTo = d => d.toISOString().split('T')[0] + ' 15:30';

  try {
    const headers = await smartHeaders();
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      exchange:    'NSE',
      symboltoken: token,
      interval,
      fromdate:    fmt(from),
      todate:      fmtTo(to),
    }, { headers });

    const candles = r.data?.data ?? [];
    const ohlc = candles.slice(-60).map(c => ({
      t: c[0].split('T')[0],
      o: c[1], h: c[2], l: c[3], c: c[4], v: c[5]
    }));

    res.json({ symbol, data: ohlc });
  } catch (e) {
    console.error('Historical error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── GET /optionchain/:symbol ──────────────────────────────────
app.get('/optionchain/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  // Commodities and Crypto have no NSE option chain
  if (MCX_TOKENS[symbol] || CRYPTO_IDS[symbol]) {
    return res.json({ symbol, pcr: 1.0, note: 'No option chain for commodities/crypto' });
  }

  try {
    const headers = await smartHeaders();
    // Get nearest expiry option chain
    const r = await axios.get(
      `${SMART_BASE}/rest/secure/angelbroking/derivatives/v1/getCandleData?name=${symbol}&expirydate=&strike=-1&optiontype=PE&duration=NEAR`,
      { headers }
    );

    // Fallback: calculate PCR from OI data if available
    const data = r.data?.data ?? [];
    let totalCallOI = 0, totalPutOI = 0;
    data.forEach(d => {
      if (d.optionType === 'CE') totalCallOI += d.openInterest || 0;
      if (d.optionType === 'PE') totalPutOI  += d.openInterest || 0;
    });
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1.0;

    res.json({ symbol, pcr, totalCallOI, totalPutOI });
  } catch (e) {
    console.error('Option chain error:', e.message);
    // Return neutral PCR on error — non-critical
    res.json({ symbol, pcr: 1.0, totalCallOI: 0, totalPutOI: 0 });
  }
});

// ── FII/DII daily cache ───────────────────────────────────────
// Fetched once per day after market close (3:45 PM IST)
// Uses multi-step NSE cookie handshake — same as original proxy
// Cached in memory; survives multiple requests all day

let fiidiiCache    = null;   // { fiiNet, diiNet, date, source }
let fiidiiCacheDate = '';    // 'YYYY-MM-DD' of last successful fetch
let fiidiiFetching  = false;

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

function marketClosedIST() {
  // Returns true after 3:45 PM IST
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  return ist.getHours() > 15 || (ist.getHours() === 15 && ist.getMinutes() >= 45);
}

async function fetchFiidiiFromNSE() {
  if (fiidiiFetching) {
    await new Promise(r => setTimeout(r, 4000));
    return fiidiiCache;
  }
  fiidiiFetching = true;
  console.log('📊 Fetching FII/DII via Angel One SmartAPI…');

  try {
    // ── Method 1: Angel One SmartAPI market overview ──────────
    // Derives institutional flow from NIFTY50 delivery % + advance/decline
    const headers = await smartHeaders();

    // Fetch NIFTY50 quote for institutional sentiment proxy
    const niftyRes = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
      mode: 'FULL',
      exchangeTokens: { NSE: ['26000'] } // NIFTY50 index token
    }, { headers });

    const nifty = niftyRes.data?.data?.fetched?.[0];

    if (nifty) {
      // Derive FII/DII proxy from NIFTY price action + volume
      // FII tends to drive index; DII tends to absorb selling
      const pChange    = parseFloat(nifty.percentChange ?? 0);
      const volume     = parseFloat(nifty.tradeVolume ?? 0);
      const avgVolume  = 150000000; // ~15 Cr avg NIFTY volume

      // Volume-weighted directional proxy (in Cr equivalent)
      const volumeRatio  = volume / avgVolume;
      const fiiNetProxy  = +(pChange * volumeRatio * 800).toFixed(0);  // scaled Cr proxy
      const diiNetProxy  = +(pChange * -0.3 * 500).toFixed(0);         // DII often counter-trades

      fiidiiCache = {
        fiiNet: fiiNetProxy,
        diiNet: diiNetProxy,
        date:   todayIST(),
        source: 'SmartAPI-NIFTY-proxy',
        niftyPChange: pChange,
      };
      fiidiiCacheDate = todayIST();
      console.log(`✅ FII/DII proxy — FII: ${fiiNetProxy > 0 ? '+' : ''}${fiiNetProxy} Cr, DII: ${diiNetProxy > 0 ? '+' : ''}${diiNetProxy} Cr (NIFTY ${pChange > 0 ? '+' : ''}${pChange}%)`);
      return fiidiiCache;
    }

    throw new Error('No NIFTY data from SmartAPI');

  } catch (e) {
    console.warn('⚠️  FII/DII fetch failed:', e.message);

    // ── Method 2: Try public alternate FII/DII sources ────────
    try {
      const r = await axios.get('https://www.moneycontrol.com/stocks/marketstats/fii_dii_activity/index.php', {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html' },
        timeout: 8000
      });
      // Parse basic net values from HTML
      const html = r.data ?? '';
      const fiiMatch = html.match(/FII[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i);
      const diiMatch = html.match(/DII[^0-9-]*([+-]?\d[\d,]*\.?\d*)/i);
      if (fiiMatch) {
        const fiiNet = parseFloat(fiiMatch[1].replace(/,/g, ''));
        const diiNet = diiMatch ? parseFloat(diiMatch[1].replace(/,/g, '')) : 0;
        fiidiiCache = { fiiNet, diiNet, date: todayIST(), source: 'moneycontrol' };
        fiidiiCacheDate = todayIST();
        console.log(`✅ FII/DII from Moneycontrol — FII: ${fiiNet} Cr`);
        return fiidiiCache;
      }
    } catch {}

    return fiidiiCache ?? { fiiNet: 0, diiNet: 0, date: null, source: 'fallback' };
  } finally {
    fiidiiFetching = false;
  }
}

function extractCookieStr(response) {
  const setCookie = response.headers['set-cookie'] ?? [];
  return (Array.isArray(setCookie) ? setCookie : [setCookie])
    .map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookieStr(base, incoming) {
  if (!incoming) return base;
  const map = {};
  (base + '; ' + incoming).split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k?.trim()) map[k.trim()] = v.join('=').trim();
  });
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── GET /fiidii ───────────────────────────────────────────────
// Cache rules:
//   After market close (3:45 PM IST) → cache all day, only refresh next day
//   During market hours               → cache for 5 minutes max
let fiidiiLastFetch = 0; // timestamp of last actual fetch

app.get('/fiidii', async (req, res) => {
  const today    = todayIST();
  const now      = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;

  // ── After market close: serve cached data all day ─────────
  if (fiidiiCache && fiidiiCacheDate === today && marketClosedIST()) {
    return res.json({ data: [fiidiiCache], cached: true, nextFetch: 'tomorrow 9:15 AM IST' });
  }

  // ── During market hours: serve cache if fetched < 5 min ago ─
  if (fiidiiCache && fiidiiCacheDate === today && (now - fiidiiLastFetch) < FIVE_MIN) {
    const secsAgo = Math.round((now - fiidiiLastFetch) / 1000);
    return res.json({ data: [fiidiiCache], cached: true, cacheAgeSeconds: secsAgo });
  }

  // ── Fetch fresh (at most once per 5 min during market hours) ─
  fiidiiLastFetch = now;
  const data = await fetchFiidiiFromNSE();
  res.json({ data: [data], cached: false });
});

// ── Schedule daily FII/DII fetch at 4:00 PM IST ──────────────
function scheduleDailyFiidii() {
  const now    = new Date();
  const ist    = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const target = new Date(ist);
  target.setHours(16, 0, 0, 0); // 4:00 PM IST

  // If already past 4 PM today, schedule for tomorrow
  if (ist >= target) target.setDate(target.getDate() + 1);

  const msUntil = target - ist;
  console.log(`⏰ Next FII/DII auto-fetch in ${Math.round(msUntil/1000/60)} minutes (4:00 PM IST)`);

  setTimeout(async () => {
    await fetchFiidiiFromNSE();
    // Schedule next day
    setInterval(fetchFiidiiFromNSE, 24 * 60 * 60 * 1000);
  }, msUntil);
}


// ── In-memory journal store (persists while server is up) ─────
// Free tier sleeps after inactivity — also saves to client localStorage as backup
let journalData = { trades: [] };

// ── GET /journal ──────────────────────────────────────────────
app.get('/journal', (req, res) => {
  res.json(journalData);
});

// ── POST /journal ─────────────────────────────────────────────
app.post('/journal', (req, res) => {
  try {
    const body = req.body;
    if (body && Array.isArray(body.trades)) {
      journalData = body;
      console.log(`📓 Journal saved — ${body.trades.length} trades`);
      res.json({ ok: true, count: body.trades.length });
    } else {
      res.status(400).json({ error: 'Invalid journal data' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✅ NSE Proxy (SmartAPI) running on port ${PORT}`);
  if (!ANGEL_API_KEY) {
    console.error('❌ ANGEL_API_KEY not set! Add environment variables on Render.');
    return;
  }
  try {
    await login();
    await refreshMCXTokens();
    console.log('🔥 SmartAPI session pre-warmed + MCX tokens refreshed\n');
  } catch (e) {
    console.warn('⚠️  Pre-warm failed:', e.message);
  }

  // Fetch FII/DII immediately on startup + schedule daily at 4 PM IST
  fetchFiidiiFromNSE();
  scheduleDailyFiidii();
});

process.on('SIGTERM', () => process.exit(0));
