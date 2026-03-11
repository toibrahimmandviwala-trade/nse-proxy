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
  'MM':          '2031',
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
async function smartHeaders() {
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
    expiresIn:    sessionExp ? Math.round((sessionExp - Date.now()) / 1000 / 60) + ' min' : 'none'
  });
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
  const token  = SYMBOL_TOKENS[symbol];
  if (!token) return res.status(404).json({ error: 'Symbol not found: ' + symbol });

  try {
    const headers = await smartHeaders();
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/market/v1/quote/`, {
      mode: 'FULL',
      exchangeTokens: { NSE: [token] }
    }, { headers });

    const d = r.data?.data?.fetched?.[0];
    if (!d) throw new Error('No quote data returned');

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
  const token     = SYMBOL_TOKENS[symbol];
  const interval  = req.query.interval || 'ONE_DAY';
  if (!token) return res.status(404).json({ error: 'Symbol not found: ' + symbol });

  // Date range: last 30 days
  const to   = new Date();
  const from = new Date(); from.setDate(to.getDate() - 35);
  const fmt  = d => d.toISOString().split('T')[0] + ' 09:00';

  try {
    const headers = await smartHeaders();
    const r = await axios.post(`${SMART_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`, {
      exchange:    'NSE',
      symboltoken: token,
      interval,
      fromdate:    fmt(from),
      todate:      fmt(to),
    }, { headers });

    const candles = r.data?.data ?? [];
    const ohlc = candles.slice(-20).map(c => ({
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
  console.log('📊 Fetching FII/DII from NSE (daily cache)…');

  const BROWSER_HEADERS = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection':      'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  try {
    // Step 1: Homepage cookie
    const r1 = await axios.get('https://www.nseindia.com/', {
      headers: BROWSER_HEADERS,
      timeout: 10000,
      maxRedirects: 5,
    });
    const c1 = extractCookieStr(r1);
    await new Promise(r => setTimeout(r, 1500));

    // Step 2: Market data page
    const r2 = await axios.get('https://www.nseindia.com/market-data/live-equity-market', {
      headers: { ...BROWSER_HEADERS, Cookie: c1, Referer: 'https://www.nseindia.com/' },
      timeout: 10000,
    });
    const c2 = mergeCookieStr(c1, extractCookieStr(r2));
    await new Promise(r => setTimeout(r, 1000));

    // Step 3: Try FII/DII endpoints with fresh cookies
    const ENDPOINTS = [
      'https://www.nseindia.com/api/fiidiiTradeReact',
      'https://www.nseindia.com/api/report-data/fii-dii-trading-activity',
      'https://www.nseindia.com/api/fii-dii',
    ];

    for (const url of ENDPOINTS) {
      try {
        const r3 = await axios.get(url, {
          headers: {
            ...BROWSER_HEADERS,
            Accept:           'application/json, text/plain, */*',
            Referer:          'https://www.nseindia.com/',
            Cookie:           c2,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          timeout: 10000,
        });

        const row  = r3.data?.data?.[0] ?? r3.data?.[0] ?? r3.data ?? {};
        const fiiNet = parseFloat(row.fiiNet ?? row.NET_FII ?? row.netFII ?? row.net ?? NaN);
        const diiNet = parseFloat(row.diiNet ?? row.NET_DII ?? row.netDII ?? 0);

        if (!isNaN(fiiNet)) {
          fiidiiCache     = { fiiNet, diiNet, date: todayIST(), source: url };
          fiidiiCacheDate = todayIST();
          console.log(`✅ FII/DII cached — FII: ${fiiNet > 0 ? '+' : ''}${fiiNet} Cr, DII: ${diiNet > 0 ? '+' : ''}${diiNet} Cr`);
          return fiidiiCache;
        }
      } catch { continue; }
    }

    throw new Error('All NSE FII/DII endpoints failed');

  } catch (e) {
    console.warn('⚠️  FII/DII fetch failed:', e.message);
    // Return last cached value if available, else neutral
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
app.get('/fiidii', async (req, res) => {
  const today = todayIST();

  // Serve from cache if same day and market is closed (data won't change)
  if (fiidiiCache && fiidiiCacheDate === today && marketClosedIST()) {
    console.log('📦 FII/DII served from cache');
    return res.json({ data: [fiidiiCache], cached: true });
  }

  // Fetch fresh data
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

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✅ NSE Proxy (SmartAPI) running on port ${PORT}`);
  if (!ANGEL_API_KEY) {
    console.error('❌ ANGEL_API_KEY not set! Add environment variables on Render.');
    return;
  }
  try {
    await login();
    console.log('🔥 SmartAPI session pre-warmed\n');
  } catch (e) {
    console.warn('⚠️  Pre-warm failed:', e.message);
  }

  // Fetch FII/DII immediately on startup + schedule daily at 4 PM IST
  fetchFiidiiFromNSE();
  scheduleDailyFiidii();
});

process.on('SIGTERM', () => process.exit(0));
