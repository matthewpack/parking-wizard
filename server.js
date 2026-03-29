const express    = require('express');
const compression = require('compression');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 8080;

// Gzip/Brotli all responses
app.use(compression());
app.use(express.json());

// ─── Flight API proxy ─────────────────────────────────────────────────────────
// Thin proxy to the Holiday Extras dock-yard flight search endpoint.
// Caches results in memory for 4 hours — flights update ~weekly so this is safe.
const flightCache = new Map(); // "LGW:2026-04-18" → { data, expires }
const CACHE_TTL   = 4 * 60 * 60 * 1000;

app.get('/api/flights', async (req, res) => {
    const { location, date, destination, query = '' } = req.query;

    // location + date are always required
    if (!location || !date)                   return res.status(400).json({ error: 'location and date required' });
    if (!/^[A-Z]{3}$/.test(location))         return res.status(400).json({ error: 'invalid location' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))   return res.status(400).json({ error: 'invalid date' });
    if (destination && !/^[A-Z]{3}$/.test(destination)) return res.status(400).json({ error: 'invalid destination' });

    // Two modes:
    //   outbound: location=LGW  + departDate=DATE  (flights OUT of parking airport)
    //   return:   location=ORIG + arrivalDate=DATE  + destination=LGW  (flights IN to parking airport)
    const isReturn = !!destination;

    // Cache key includes query so filtered results don't poison the full-list cache
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
});

// ─── Parking search ───────────────────────────────────────────────────────────
// Accepts our clean semantic payload, builds the HX URL, logs the search, returns redirectUrl.
// Decouples the frontend from HX's internal URL structure — update this one place when HX changes.

const searchLog = [];          // rolling in-memory log — no PII
const LOG_MAX   = 200;

function buildHxUrl({ parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight }) {
    // HX search uses a hash-based route: /static/?selectProduct=cp&reloadKey=KEY#/categories?...
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

app.post('/api/parking/search', (req, res) => {
    const { parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight, returnFlight } = req.body || {};

    if (!parkingAirport || !parkingDropoffDate || !parkingDropoffTime || !parkingReturnDate || !parkingReturnTime)
        return res.status(400).json({ error: 'missing required parking fields' });

    const redirectUrl = buildHxUrl(req.body);

    // Calculate nights for the log
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
});

app.get('/api/log', (req, res) => {
    res.json(searchLog);
});

// Long-lived cache for immutable assets (images, fuse.js, favicons)
app.use(express.static(path.join(__dirname), {
    maxAge: '30d',
    etag:   true,
    lastModified: true,
    setHeaders(res, filePath) {
        // index.html must always revalidate so deploys take effect immediately
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    },
}));

app.listen(PORT, () => console.log('Parking wizard listening on port', PORT));
