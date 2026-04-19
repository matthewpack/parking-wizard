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

function buildHxUrl({ parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight, agentCode }) {
    const hashParams = new URLSearchParams({
        agent:           agentCode || 'WEB1',
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
    const { parkingAirport, parkingDropoffDate, parkingDropoffTime, parkingReturnDate, parkingReturnTime, outboundFlight, returnFlight, agentCode, visitorId } = req.body || {};

    if (!parkingAirport || !parkingDropoffDate || !parkingDropoffTime || !parkingReturnDate || !parkingReturnTime)
        return res.status(400).json({ error: 'missing required parking fields' });

    const redirectUrl = buildHxUrl(req.body);

    const msPerDay = 86400000;
    const nights   = Math.round((new Date(parkingReturnDate) - new Date(parkingDropoffDate)) / msPerDay);

    const entry = {
        ts:                       new Date().toISOString(),
        agentCode:                agentCode || 'WEB1',
        visitorId:                visitorId || null,
        parkingAirport,
        nights,
        parkingDropoffDate,
        parkingDropoffTime,
        parkingReturnDate,
        parkingReturnTime,

        outboundFlight:            outboundFlight?.code              || null,
        outboundReference:         outboundFlight?.reference         || '',
        outboundDepartureAirport:  outboundFlight?.departureAirport  || '',
        outboundDepartureDate:     outboundFlight?.departureDate     || '',
        outboundDepartureTime:     outboundFlight?.departureTime     || '',
        outboundDepartureTerminal: outboundFlight?.departureTerminal || '',
        outboundArrivalAirport:    outboundFlight?.arrivalAirport    || '',
        outboundArrivalDate:       outboundFlight?.arrivalDate       || '',
        outboundArrivalTime:       outboundFlight?.arrivalTime       || '',
        outboundDest:              outboundFlight?.dest              || outboundFlight?.arrivalAirport || '',

        returnFlight:              returnFlight?.code                || null,
        returnReference:           returnFlight?.reference           || '',
        returnDepartureAirport:    returnFlight?.departureAirport    || '',
        returnDepartureDate:       returnFlight?.departureDate       || '',
        returnDepartureTime:       returnFlight?.departureTime       || '',
        returnDepartureTerminal:   returnFlight?.departureTerminal   || '',
        returnArrivalAirport:      returnFlight?.arrivalAirport      || '',
        returnArrivalDate:         returnFlight?.arrivalDate         || '',
        returnArrivalTime:         returnFlight?.arrivalTime         || '',
        returnArrivalTerminal:     returnFlight?.arrivalTerminal     || '',
        returnOrigin:              returnFlight?.departureAirport    || '',

        redirectUrl,
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

// ─── Admin log (auth-gated via ?key=ADMIN_KEY) ───────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY;

function checkAuth(req, res) {
    if (ADMIN_KEY && req.query.key !== ADMIN_KEY) {
        res.status(401).type('text/plain').send('Unauthorised — add ?key=YOUR_KEY to the URL');
        return false;
    }
    return true;
}

function logHandler(req, res) {
    if (!checkAuth(req, res)) return;
    const rows = [...searchLog].reverse();
    res.json({ total: rows.length, rows });
}

function logCsvHandler(req, res) {
    if (!checkAuth(req, res)) return;
    const cols = ['ts','agentCode','visitorId','parkingAirport','nights',
                  'parkingDropoffDate','parkingDropoffTime','parkingReturnDate','parkingReturnTime',
                  'outboundFlight','outboundReference',
                  'outboundDepartureAirport','outboundDepartureDate','outboundDepartureTime','outboundDepartureTerminal',
                  'outboundArrivalAirport','outboundArrivalDate','outboundArrivalTime','outboundDest',
                  'returnFlight','returnReference',
                  'returnDepartureAirport','returnDepartureDate','returnDepartureTime','returnDepartureTerminal',
                  'returnArrivalAirport','returnArrivalDate','returnArrivalTime','returnArrivalTerminal','returnOrigin',
                  'redirectUrl'];
    const esc = v => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`;
    const rows = [...searchLog].reverse();
    const csv  = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="parking-searches-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
}

function adminHandler(req, res) {
    if (!checkAuth(req, res)) return;
    const keyParam = ADMIN_KEY ? `?key=${encodeURIComponent(ADMIN_KEY)}` : '';
    const mount    = req.baseUrl || '';
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Parking Wizard — Search Log</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:#f8f8f8;color:#222}
header{background:#552e92;color:#fff;padding:.875rem 1.25rem;display:flex;align-items:center;justify-content:space-between;gap:1rem}
header h1{font-size:1rem;font-weight:700}
header a{color:#e2d9f3;font-size:.8rem;text-decoration:none;border:1px solid #7c5cbf;border-radius:6px;padding:.3rem .75rem}
header a:hover{background:#3d2070}
.bar{padding:.625rem 1.25rem;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.bar input{border:1px solid #cbd5e0;border-radius:6px;padding:.35rem .65rem;font-size:13px;width:280px}
.stat{font-size:.8rem;color:#718096}
.stat strong{color:#222}
table{width:100%;border-collapse:collapse;background:#fff}
th{background:#f1f0f8;color:#552e92;font-weight:700;font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .75rem;text-align:left;position:sticky;top:0;white-space:nowrap}
td{padding:.45rem .75rem;border-bottom:1px solid #f0f0f0;vertical-align:top;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
tr:hover td{background:#faf8ff}
.wrap{overflow-x:auto;max-height:calc(100vh - 100px)}
.apt{display:inline-block;background:#ede7f6;color:#512da8;font-weight:700;font-size:.72rem;padding:2px 6px;border-radius:3px}
.flt{font-family:ui-monospace,Menlo,monospace;font-size:.78rem}
.nil{color:#999}
.sent a{color:#2e7d32;text-decoration:none;font-weight:600}
.sent a:hover{text-decoration:underline}
</style></head><body>
<header>
  <h1>🅿️ Parking Wizard — Search Log (last ${searchLog.length ? searchLog.length : 0} in memory)</h1>
  <nav style="display:flex;gap:.5rem;align-items:center">
    <a href="${mount}/api/log.csv${keyParam}" download>⬇ CSV</a>
    <a href="${mount}/api/log${keyParam}">JSON</a>
  </nav>
</header>
<div class="bar">
  <input type="search" id="q" placeholder="Filter by agent, airport, flight, visitor ID…" oninput="filter()">
  <span class="stat" id="stat"></span>
</div>
<div class="wrap"><table id="tbl">
<thead><tr>
  <th>Time</th><th>Agent</th><th>Visitor ID</th><th>Airport</th><th>Nights</th>
  <th>Drop-off</th><th>Return</th>
  <th>Outbound flight</th><th>Outbound depart</th><th>Outbound arrive</th>
  <th>Return flight</th><th>Return depart</th><th>Return arrive</th>
  <th>Sent to</th>
</tr></thead>
<tbody id="tbody"></tbody>
</table></div>
<script>
let rows=[];
async function load(){
  const r=await fetch('${mount}/api/log${keyParam}');
  const d=await r.json();
  rows=d.rows||[];
  document.getElementById('stat').innerHTML='<strong>'+rows.length+'</strong> searches';
  render(rows);
}
function esc(s){return s==null?'':String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');}
function fmt(ts){if(!ts)return'';const d=new Date(ts);return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});}
function fmtDate(d){if(!d)return'';return new Date(d).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});}
function nilOr(v){return v?esc(v):'<span class="nil">—</span>';}
function copyVid(btn){navigator.clipboard.writeText(btn.dataset.vid);btn.textContent='✓';setTimeout(()=>btn.textContent='⧉',1200);}
function vidCell(v){if(!v)return'<span class="nil">—</span>';const short=v.slice(0,12)+(v.length>12?'…':'');return'<span title="'+esc(v)+'">'+esc(short)+'</span> <button data-vid="'+esc(v)+'" onclick="copyVid(this)" title="Copy visitor ID" style="background:none;border:none;cursor:pointer;font-size:0.85em;opacity:0.6;padding:0">⧉</button>';}
function flt(code,loc,term,ref){if(!code)return'<span class="nil">—</span>';const t=term?' T'+esc(term):'';const l=loc?' '+esc(loc):'';const title=ref?' title="ref: '+esc(ref)+'"':'';return'<span class="flt"'+title+'>'+esc(code)+'</span>'+l+t;}
function dt(date,time,airport){if(!date&&!time)return'<span class="nil">—</span>';const a=airport?' '+esc(airport):'';return fmtDate(date)+' '+esc(time||'')+a;}
function sent(url){if(!url)return'<span class="nil">—</span>';return'<span class="sent"><a href="'+esc(url)+'" target="_blank">open ↗</a></span>';}
function render(data){
  document.getElementById('tbody').innerHTML=data.map(r=>'<tr>'+
    '<td title="'+esc(r.ts)+'">'+fmt(r.ts)+'</td>'+
    '<td>'+esc(r.agentCode)+'</td>'+
    '<td>'+vidCell(r.visitorId)+'</td>'+
    '<td><span class="apt">'+esc(r.parkingAirport)+'</span></td>'+
    '<td>'+esc(r.nights)+'</td>'+
    '<td>'+fmtDate(r.parkingDropoffDate)+' '+esc(r.parkingDropoffTime||'')+'</td>'+
    '<td>'+fmtDate(r.parkingReturnDate)+' '+esc(r.parkingReturnTime||'')+'</td>'+
    '<td>'+flt(r.outboundFlight,r.outboundDest,r.outboundDepartureTerminal,r.outboundReference)+'</td>'+
    '<td>'+dt(r.outboundDepartureDate,r.outboundDepartureTime,r.outboundDepartureAirport)+'</td>'+
    '<td>'+dt(r.outboundArrivalDate,r.outboundArrivalTime,r.outboundArrivalAirport)+'</td>'+
    '<td>'+flt(r.returnFlight,r.returnOrigin,r.returnArrivalTerminal,r.returnReference)+'</td>'+
    '<td>'+dt(r.returnDepartureDate,r.returnDepartureTime,r.returnDepartureAirport)+'</td>'+
    '<td>'+dt(r.returnArrivalDate,r.returnArrivalTime,r.returnArrivalAirport)+'</td>'+
    '<td>'+sent(r.redirectUrl)+'</td>'+
  '</tr>').join('');
}
function filter(){
  const q=document.getElementById('q').value.toLowerCase();
  render(q?rows.filter(r=>JSON.stringify(r).toLowerCase().includes(q)):rows);
}
load();
</script></body></html>`);
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
    // req.baseUrl is the prefix the router was mounted at:
    //   '' when reached via the root router (direct Heroku URL)
    //   '/parking-wizard' when reached via the sub-path router (HX proxy)
    // Only inject base href and _basePath when actually serving from a sub-path —
    // injecting on the root URL breaks GPS and other functionality unnecessarily.
    const mountedAt = req.baseUrl || '';
    if (!mountedAt) {
        res.sendFile(path.join(__dirname, 'index.html'));
    } else {
        const html = getIndexHtml()
            .replace('<head>', `<head><base href="${mountedAt}/">`)
            .replace('</head>', `<script>window._basePath='${mountedAt}'</script></head>`);
        res.send(html);
    }
}

// ─── Router — all app routes in one place ────────────────────────────────────
function mountRoutes(router, basePath) {
    router.get('/api/flights',          flightsHandler);
    router.post('/api/parking/search',  parkingSearchHandler);
    router.get('/api/log',              logHandler);
    router.get('/api/log.csv',          logCsvHandler);
    router.get('/admin',                adminHandler);

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

// Mount MOUNT_PATH router FIRST so it wins over the root catch-all.
// If registered after app.use('/', rootRouter), the root catch-all would
// swallow /parking-wizard/logo.jpg before the sub-path router could handle it.
if (MOUNT_PATH) {
    const subRouter = express.Router();
    mountRoutes(subRouter);
    app.use(MOUNT_PATH, subRouter);
    console.log(`[mount] Serving at ${MOUNT_PATH}`);
}

// Root router last — handles direct Heroku URL access
const rootRouter = express.Router();
mountRoutes(rootRouter);
app.use('/', rootRouter);

app.listen(PORT, () => console.log(`Parking wizard listening on port ${PORT}${MOUNT_PATH ? ' (also at ' + MOUNT_PATH + ')' : ''}`));
