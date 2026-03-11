/**
 * ================================================================
 *  NSE INDIA PROXY — Lightweight (no Puppeteer)
 *  Uses multi-step cookie handshake to mimic a real browser.
 *  Deploys on Render free tier in under 60 seconds.
 * ================================================================
 */

const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── NSE config ────────────────────────────────────────────────
const NSE_BASE = 'https://www.nseindia.com';
const ALLOWED_PATHS = [
  '/api/quote-equity',
  '/api/historical/cm/equity',
  '/api/historical/',
  '/api/option-chain-equities',
  '/api/option-chain-equity',
  '/api/report-data/fii-dii-trading-activity',
  '/api/fiidiiTradeReact',
  '/api/fii-dii',
  '/api/allIndices',
];

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
  'Cache-Control':   'max-age=0',
};

// ── Cookie cache ──────────────────────────────────────────────
let cookieJar  = '';
let cookieExp  = 0;
let refreshing = false;

// ── Multi-step NSE cookie handshake ──────────────────────────
async function refreshCookies() {
  if (refreshing) {
    // Wait for ongoing refresh
    await new Promise(r => setTimeout(r, 3000));
    return cookieJar;
  }
  refreshing = true;
  console.log('🔄 Refreshing NSE cookies…');

  try {
    // Step 1: Hit homepage
    const r1 = await fetch('https://www.nseindia.com/', {
      headers: HEADERS,
      redirect: 'follow',
    });
    const c1 = extractCookies(r1);

    await sleep(1200);

    // Step 2: Hit market data page with cookies from step 1
    const r2 = await fetch('https://www.nseindia.com/market-data/live-equity-market', {
      headers: { ...HEADERS, 'Cookie': c1, 'Referer': 'https://www.nseindia.com/' },
      redirect: 'follow',
    });
    const c2 = mergeCookies(c1, extractCookies(r2));

    await sleep(800);

    // Step 3: Hit a lightweight JSON endpoint to finalize session
    const r3 = await fetch('https://www.nseindia.com/api/allIndices', {
      headers: {
        ...HEADERS,
        'Accept':   'application/json, text/plain, */*',
        'Referer':  'https://www.nseindia.com/',
        'Cookie':   c2,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      }
    });
    const c3 = mergeCookies(c2, extractCookies(r3));

    cookieJar = c3 || c2 || c1;
    cookieExp = Date.now() + 18 * 60 * 1000; // 18 min cache
    console.log(`✅ Cookies refreshed (${cookieJar.length} chars), valid 18 min`);
    return cookieJar;

  } catch (err) {
    console.error('❌ Cookie refresh failed:', err.message);
    throw err;
  } finally {
    refreshing = false;
  }
}

function extractCookies(response) {
  const raw = response.headers.raw?.()['set-cookie'] ||
              (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
  return raw.map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

function mergeCookies(base, incoming) {
  if (!incoming) return base;
  const map = {};
  (base + '; ' + incoming).split(';').forEach(pair => {
    const [k, ...v] = pair.trim().split('=');
    if (k) map[k.trim()] = v.join('=').trim();
  });
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getCookies() {
  if (cookieJar && Date.now() < cookieExp) return cookieJar;
  return refreshCookies();
}

// ── Health ────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status:      'ok',
    service:     'NSE Proxy (lightweight)',
    cookieReady: !!cookieJar && Date.now() < cookieExp,
    expiresIn:   cookieExp ? Math.round((cookieExp - Date.now()) / 1000) + 's' : 'none'
  });
});

// ── Warmup ────────────────────────────────────────────────────
app.get('/warmup', async (req, res) => {
  try {
    await refreshCookies();
    res.json({ status: 'ok', message: 'Cookies ready!', chars: cookieJar.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Main proxy ────────────────────────────────────────────────
app.get('/api/*', async (req, res) => {
  const reqPath = req.path;
  const allowed = ALLOWED_PATHS.some(p => reqPath.startsWith(p));
  if (!allowed) return res.status(403).json({ error: 'Path not allowed: ' + reqPath });

  const query  = req.url.replace(req.path, '');
  const nseUrl = NSE_BASE + reqPath + query;
  console.log('📡', nseUrl);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const cookies  = await getCookies();
      const response = await fetch(nseUrl, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer':         'https://www.nseindia.com/',
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie':          cookies,
          'Sec-Fetch-Dest':  'empty',
          'Sec-Fetch-Mode':  'cors',
          'Sec-Fetch-Site':  'same-origin',
        }
      });

      if ((response.status === 401 || response.status === 403) && attempt === 1) {
        console.log('⚠️  Auth error — forcing cookie refresh…');
        cookieJar = ''; cookieExp = 0;
        continue;
      }

      const text = await response.text();
      return res.status(response.status)
        .set('Content-Type', 'application/json')
        .set('Cache-Control', 'no-store')
        .send(text);

    } catch (err) {
      if (attempt === 2) {
        console.error('❌', err.message);
        return res.status(502).json({ error: 'Proxy error', detail: err.message });
      }
    }
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✅ NSE Proxy (lightweight) running on port ${PORT}`);
  try {
    await refreshCookies();
    console.log('🔥 Pre-warmed and ready\n');
  } catch (e) {
    console.warn('⚠️  Pre-warm failed (will retry on first request):', e.message);
  }
});

process.on('SIGTERM', () => process.exit(0));
