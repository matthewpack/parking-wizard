const express    = require('express');
const compression = require('compression');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 8080;

// Optional sub-path mount, e.g. '/parking-wizard' for path-based proxy routing.
// Leave unset (or set to '') when running at root.
const MOUNT_PATH = (process.env.MOUNT_PATH || '').replace(/\/$/, '');

// Gzip/Brotli all responses
app.use(compression());
app.use(express.json());

// ─── Flight API proxy ─────────────────────────────────────────────────────────
const flightCache = new Map();
const CACHE_TTL   = 4 * 60 * 60 * 1000;

async function flightsHandler(req, res) {
    const { location, date, destination, query = '' } = req.query;

    if (!location || !date)                   return res.status(400).json({ error: 'location and date required' });
    if (!/^[A-Z]{3}$/.test(location))         return res.status(400).json({ error: 'invalid location' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))   return res.status(400).json({ error: 'invalid date' });
    if (destination && !/^[A-Z]{3}$/.test(destination)) return res.status(400).json({ error: 'invalid destination' });

    const isReturn = !!destination;
    const key    = location + ':' + date + (isReturn ? ':in:' + destination : ':out') + (query ? ':q:' + query : '');
    const cached = flightCache.get(key);
    if (cached && cached.expires > Date.now()) return res.json(cached.data);

    try {
        const params = new URLSearchParams({ query, location, country: '' });
        if (isReturn) { params.set('arrivalDate', date); params.set('destination', destination); }
        else          { params.set('departDate',  date); }

        const url      = `https://www.holidayextras.com/dock-yard/flight/search?${params}`;
        const upstream = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'parking-wizard/1.0' } });
        if (!upstream.ok) return res.status(upstream.status).json({ error: 'upstream error' });
        const data = await upstream.json();
        flightCache.set(key, { data, expires: Date.now() + CACHE_TTL });
        res.json(data);
    } catch (e) {
        console.error('[flights]', e.message);
        res.status(502).json({ error: 'fetch failed' });
    }
}

// ─── Parking search ───────────────────────────────────────────────────────────
const searchLog = [];
const LOG_MAX   = 200;

function buildHxUrl({ parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight }) {
    const hashParams = new URLSearchParams({
        agent:           'WEB1',
        depart:          parkingAirport,
        out:             parkingDropoffDate,
        park_from:       parkingDropoffTime,
        in:              parkingReturnDate,
        park_to:         parkingReturnTime,
        flight:          outboundFlight?.code  || '',
        terminal:        outboundFlight?.departureTerminal || '',
        redirectReferal: 'carpark',
        from_categories: 'true',
    });
    return `https://www.holidayextras.com/static/?selectProduct=cp&reloadKey=d1b72610#/categories?${hashParams}`;
}

function parkingSearchHandler(req, res) {
    const { parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight, returnFlight } = req.body || {};

    if (!parkingAirport || !parkingDropoffDate || !parkingDropoffTime || !parkingReturnDate || !parkingReturnTime)
        return res.status(400).json({ error: 'missing required parking fields' });

    const redirectUrl = buildHxUrl(req.body);

    const msPerDay = 86400000;
    const nights   = Math.round((new Date(parkingReturnDate) - new Date(parkingDropoffDate)) / msPerDay);

    const entry = {
        ts:                       new Date().toISOString(),
        parkingAirport,
        nights,
        parkingDropoffDate,
        parkingDropoffTime,
        parkingReturnDate,
        parkingReturnTime,
        outboundFlight:            outboundFlight?.code             || null,
        outboundDepartureTerminal: outboundFlight?.departureTerminal || '',
        returnFlight:              returnFlight?.code               || null,
        returnArrivalTerminal:     returnFlight?.arrivalTerminal     || '',
    };
    searchLog.push(entry);
    if (searchLog.length > LOG_MAX) searchLog.shift();

    console.log('\n' + '='.repeat(60));
    console.log('  POST /api/parking/search');
    console.log(`  ${entry.ts}`);
    console.log(`  ${parkingAirport} | ${nights} night${nights === 1 ? '' : 's'} | ${parkingDropoffDate} → ${parkingReturnDate}`);
    if (outboundFlight) console.log(`  outbound: ${outboundFlight.code} (terminal ${outboundFlight.departureTerminal || '-'}) to ${outboundFlight.arrivalAirport}`);
    if (returnFlight)   console.log(`  return:   ${returnFlight.code} (terminal ${returnFlight.arrivalTerminal || '-'}) from ${returnFlight.departureAirport}`);
    console.log(`  → ${redirectUrl.slice(0, 90)}...`);
    console.log('='.repeat(60) + '\n');

    res.json({ redirectUrl });
}

function logHandler(req, res) {
    res.json(searchLog);
}

// ─── index.html with injected base path ───────────────────────────────────────
// Reads index.html once and injects window._basePath so the client JS
// knows the correct API prefix when mounted under a sub-path.
let _indexHtml = null;
function getIndexHtml() {
    if (!_indexHtml) _indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    return _indexHtml;
}

function indexHandler(req, res) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (!MOUNT_PATH) {
        // Serving at root — no injection needed, stream directly
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        // Inject <base href> immediately after <meta charset> so the browser
        // resolves ALL relative asset URLs (logo, fonts, favicons, images)
        // relative to the mount path — not the domain root.
        // Also inject window._basePath so the client JS API calls use the right prefix.
        const html = getIndexHtml()
            .replace(
                '<head>',
                `<head><base href="${MOUNT_PATH}/">`
            )
            .replace(
                '</head>',
                `<script>window._basePath='${MOUNT_PATH}'</script></head>`
            );
        res.send(html);
    }
}

// ─── Router — all app routes in one place ────────────────────────────────────
function mountRoutes(router, basePath) {
    router.get('/api/flights',          flightsHandler);
    router.post('/api/parking/search',  parkingSearchHandler);
    router.get('/api/log',              logHandler);

    // Static assets — images, fonts, fuse.js, favicons
    // index.html is served explicitly above so we can inject the base path;
    // the static middleware handles everything else.
    router.use(express.static(path.join(__dirname), {
        maxAge: '30d',
        etag:   true,
        lastModified: true,
        index: false,   // don't auto-serve index.html — our explicit route does that
        setHeaders(res, filePath) {
            if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
        },
    }));

    // SPA catch-all — serve index.html for any unmatched GET (handles deep links / refreshes)
    router.get('*', indexHandler);
}

// Always mount at root (direct Heroku URL access)
const rootRouter = express.Router();
mountRoutes(rootRouter);
app.use('/', rootRouter);

// Also mount at MOUNT_PATH if set (path-based proxy, e.g. /parking-wizard)
if (MOUNT_PATH) {
    const subRouter = express.Router();
    mountRoutes(subRouter);
    app.use(MOUNT_PATH, subRouter);
    console.log(`[mount] Also serving at ${MOUNT_PATH}`);
}

app.listen(PORT, () => console.log(`Parking wizard listening on port ${PORT}${MOUNT_PATH ? ' (also at ' + MOUNT_PATH + ')' : ''}`));
