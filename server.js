/**
 * ================================================================
 *  NSE INDIA PROXY SERVER
 *  Express + Puppeteer — runs a real Chrome browser to get NSE
 *  session cookies, then proxies all API calls with those cookies.
 * ================================================================
 */

const express   = require('express');
const cors      = require('cors');
const puppeteer = require('puppeteer');
const fetch     = require('node-fetch');

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

// ── Session cache ─────────────────────────────────────────────
let sessionCookies = '';
let cookieExpiry   = 0;
let browser        = null;

// ── Launch Puppeteer ──────────────────────────────────────────
async function getBrowser() {
  if (browser) {
    try { await browser.version(); return browser; } catch { browser = null; }
  }
  console.log('🚀 Launching Puppeteer…');
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update',
    ]
  });
  return browser;
}

// ── Refresh NSE cookies via real browser ─────────────────────
async function getNSECookies() {
  const now = Date.now();
  if (sessionCookies && now < cookieExpiry) return sessionCookies;

  console.log('🔄 Fetching fresh NSE cookies…');
  const b    = await getBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    await page.goto('https://www.nseindia.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 3000));

    const cookies = await page.cookies();
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    cookieExpiry   = now + 20 * 60 * 1000;

    console.log(`✅ Got ${cookies.length} cookies`);
    return sessionCookies;
  } finally {
    await page.close();
  }
}

// ── Health check ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NSE Proxy (Puppeteer)',
    cookiesCached: !!sessionCookies && Date.now() < cookieExpiry,
    expiresIn: cookieExpiry ? Math.round((cookieExpiry - Date.now()) / 1000) + 's' : 'none'
  });
});

// ── Warmup ────────────────────────────────────────────────────
app.get('/warmup', async (req, res) => {
  try {
    await getNSECookies();
    res.json({ status: 'ok', message: 'Cookies warmed up successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy all /api/* to NSE ───────────────────────────────────
app.get('/api/*', async (req, res) => {
  const reqPath = req.path;
  const allowed = ALLOWED_PATHS.some(p => reqPath.startsWith(p));
  if (!allowed) return res.status(403).json({ error: 'Path not allowed: ' + reqPath });

  const query  = req.url.replace(req.path, '');
  const nseUrl = NSE_BASE + reqPath + query;
  console.log('📡', nseUrl);

  try {
    let cookies = await getNSECookies();

    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await fetch(nseUrl, {
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Referer':         'https://www.nseindia.com/',
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie':          cookies,
          'sec-fetch-dest':  'empty',
          'sec-fetch-mode':  'cors',
          'sec-fetch-site':  'same-origin',
        }
      });

      if ((response.status === 401 || response.status === 403) && attempt === 1) {
        console.log('⚠️  Auth error — refreshing cookies…');
        sessionCookies = ''; cookieExpiry = 0;
        cookies = await getNSECookies();
        continue;
      }

      const text = await response.text();
      return res.status(response.status)
        .set('Content-Type', 'application/json')
        .set('Cache-Control', 'no-store')
        .send(text);
    }
  } catch (err) {
    console.error('❌', err.message);
    res.status(502).json({ error: 'Proxy error', detail: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`✅ NSE Proxy on port ${PORT}`);
  try {
    await getNSECookies();
    console.log('🔥 Pre-warmed on startup');
  } catch (e) {
    console.warn('⚠️  Pre-warm failed:', e.message);
  }
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
