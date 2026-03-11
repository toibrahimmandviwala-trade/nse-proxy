/**
 * ================================================================
 *  NSE INDIA PROXY SERVER
 *  Express + Puppeteer — runs a real Chrome browser to get NSE
 *  session cookies, then proxies all API calls with those cookies.
 *
 *  Deploy free on Render.com:
 *  1. Push this folder to GitHub
 *  2. New Web Service on Render → connect repo → Start Command: node server.js
 * ================================================================
 */

const express    = require('express');
const cors       = require('cors');
const puppeteer  = require('puppeteer');
const fetch      = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS — allow your Netlify app ─────────────────────────────
const ALLOWED_ORIGINS = [
  'https://melodic-shortbread-a97330.netlify.app',  // ← your Netlify URL
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

// ── Session cookie cache ──────────────────────────────────────
let sessionCookies = '';    // "key=val; key2=val2" string
let cookieExpiry   = 0;     // timestamp ms
let browser        = null;  // shared Puppeteer browser instance

// ── Puppeteer: launch browser once ───────────────────────────
async function getBrowser() {
  if (browser) {
    try { await browser.version(); return browser; } catch {}
  }
  console.log('🚀 Launching Puppeteer browser…');
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',    // important for Render free tier
      '--disable-extensions',
    ]
  });
  return browser;
}

// ── Get fresh NSE session cookie via real browser visit ───────
async function getNSECookies() {
  const now = Date.now();
  if (sessionCookies && now < cookieExpiry) {
    console.log('✅ Using cached NSE cookies');
    return sessionCookies;
  }

  console.log('🔄 Refreshing NSE session cookies via Puppeteer…');
  const b    = await getBrowser();
  const page = await b.newPage();

  try {
    // Set a real browser user-agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Visit NSE homepage — this sets all required session cookies
    await page.goto('https://www.nseindia.com', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Wait a moment for any JS-set cookies
    await new Promise(r => setTimeout(r, 2000));

    // Also visit the market data page to get additional cookies
    await page.goto('https://www.nseindia.com/market-data/live-equity-market', {
      waitUntil: 'networkidle2',
      timeout: 20000
    });

    await new Promise(r => setTimeout(r, 1000));

    // Extract cookies
    const cookies = await page.cookies();
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    cookieExpiry   = now + 20 * 60 * 1000; // cache 20 minutes

    console.log(`✅ Got ${cookies.length} NSE cookies, cached for 20 min`);
    return sessionCookies;

  } catch (err) {
    console.error('❌ Puppeteer cookie fetch failed:', err.message);
    throw err;
  } finally {
    await page.close();
  }
}

// ── Health check endpoint ─────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NSE Proxy',
    cookiesCached: !!sessionCookies && Date.now() < cookieExpiry,
    cookieExpiresIn: cookieExpiry ? Math.round((cookieExpiry - Date.now()) / 1000) + 's' : 'none'
  });
});

// ── Warm up endpoint (call once after deploy to prime cookies) ─
app.get('/warmup', async (req, res) => {
  try {
    await getNSECookies();
    res.json({ status: 'warmed up', cookies: sessionCookies.length + ' chars' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Main proxy endpoint — handles all /api/* NSE paths ────────
app.get('/api/*', async (req, res) => {
  const reqPath = req.path; // e.g. /api/quote-equity

  // Whitelist check
  const allowed = ALLOWED_PATHS.some(p => reqPath.startsWith(p));
  if (!allowed) {
    return res.status(403).json({ error: 'Path not allowed: ' + reqPath });
  }

  // Build NSE URL with original query string
  const query  = req.url.replace(req.path, ''); // just the ?query=string part
  const nseUrl = NSE_BASE + reqPath + query;
  console.log('📡 Proxying:', nseUrl);

  try {
    const cookies = await getNSECookies();

    // Retry once on failure (cookies may be stale)
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(nseUrl, {
          method: 'GET',
          headers: {
            'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Referer':         'https://www.nseindia.com/',
            'Accept':          'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection':      'keep-alive',
            'Cookie':          cookies,
            'sec-fetch-dest':  'empty',
            'sec-fetch-mode':  'cors',
            'sec-fetch-site':  'same-origin',
          }
        });

        if (response.status === 401 || response.status === 403) {
          if (attempt === 1) {
            // Force cookie refresh and retry
            console.log('⚠️  Auth error, refreshing cookies and retrying…');
            sessionCookies = '';
            cookieExpiry   = 0;
            await getNSECookies();
            continue;
          }
        }

        const text = await response.text();
        res.status(response.status)
           .set('Content-Type', 'application/json')
           .set('Cache-Control', 'no-store')
           .send(text);
        return;

      } catch (fetchErr) {
        if (attempt === 2) throw fetchErr;
      }
    }

  } catch (err) {
    console.error('❌ Proxy error:', err.message);
    res.status(502).json({ error: 'NSE fetch failed', detail: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✅ NSE Proxy server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/`);
  console.log(`   Warmup: http://localhost:${PORT}/warmup\n`);

  // Pre-warm cookies on startup
  try {
    await getNSECookies();
    console.log('🔥 Cookies pre-warmed on startup\n');
  } catch (err) {
    console.warn('⚠️  Pre-warm failed (will retry on first request):', err.message);
  }
});

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('Shutting down…');
  if (browser) await browser.close();
  process.exit(0);
});
