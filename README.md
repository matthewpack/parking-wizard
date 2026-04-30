# Parking Wizard

A streamlined, mobile-first booking wizard for Holiday Extras airport parking. Guides users through an 8-step flow — airport, dates, times, and optional outbound/return flights — then hands them off to the Holiday Extras checkout with all search parameters pre-filled.

**Status:** Live in production (v1.0.0) at `holidayextras.com/airport-parking-wizard/`, serving ~3k visitors/day.

---

## Features

- **8-step guided wizard** — airport → drop-off date → outbound flight → drop-off time → return date → return flight → return time → review & submit
- **GPS + IP location detection** — IP lookup fires immediately on load; GPS runs in parallel and upgrades the result silently if permission is already granted. On Mac/desktop without a GPS chip, automatically retries with low-accuracy (WiFi/OS network location). No delay waiting for GPS to time out.
- **Flight search** — live flight data with full-text search (Fuse.js), codeshare deduplication, city name display, and recent/favourite flights
- **Smart time defaults** — pre-selects recommended drop-off/return times based on flight schedule, including correct midnight-wrap logic for overnight long-haul returns
- **Return flight date logic** — date tabs represent the day the flight *lands* at the parking airport. Both the selected date and the day before are fetched from the API and merged, then filtered to only show arrivals on the chosen date — so Bangkok→London overnight flights appear under the correct landing date
- **Edge-case time picker** — 25 options: `00:01`, `01:00`–`23:00`, `23:59`; overnight collection times wrap correctly past midnight
- **Recents & favourites** — airports and flights persist in localStorage for quick repeat bookings
- **Seamless HX handoff** — submits to Holiday Extras with all parameters serialised into the correct URL format
- **Shimmer skeleton loading** — while flights load, animated placeholder rows mirror the real flight row layout so the UI never shows a blank container
- **HX agent code** — reads the `agent` cookie / URL param / sessionStorage set by holidayextras.com and passes it through the search payload to control product visibility and pricing on the results page
- **HX auth token capture** — server-side reads the `auth_token` cookie (HttpOnly, invisible to JS) from the request header so the downstream trip-reconstruction team can link searches back to a customer
- **Visitor ID capture** — stable per-browser ID saved to localStorage and logged alongside each search
- **Prefetch / commit pattern** — the summary page prefetches the redirect URL without logging; only the actual "Show prices" click fires a `keepalive` POST that records the search
- **Postgres-backed search log** — every completed search is persisted to Postgres; rolling 24-hour window shown in the admin dashboard
- **Admin dashboard** — `/admin` (auth-gated via `?key=ADMIN_KEY`) with live filter, click-to-copy IDs, CSV export
- **WebP assets** — logo and hero images served as WebP with JPEG/PNG fallback (~60 KiB saved per first-time visitor)
- **Server-side flight caching** — 4-hour in-memory cache on the proxy layer; capped at 500 entries with a 30-minute TTL sweep and FIFO hard-eviction to prevent unbounded memory growth
- **JS/CSS minification** — `html-minifier-terser` runs as a `heroku-postbuild` step
- **iPhone safe-area support** — `viewport-fit=cover` + `env(safe-area-inset-top)` for PWA/home-screen installs

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 (single-page, no framework) |
| Search | [Fuse.js](https://fusejs.io/) v7 (client-side fuzzy search) |
| Font | Nunito (self-hosted WOFF2) |
| Backend | Node.js 20 + Express 4 |
| Database | Postgres (via `pg`), auto-provisioned on Heroku |
| Compression | gzip/Brotli via `compression` middleware |
| Minification | `html-minifier-terser` (Heroku post-build) |
| Deployment | Heroku-compatible (`Procfile`) |

---

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Install & run

```bash
git clone <repo-url>
cd parking-wizard
npm install
npm start
```

The server starts on port `8080` by default. Open `http://localhost:8080` in your browser.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP port the server listens on |
| `MOUNT_PATH` | _(empty)_ | Optional sub-path prefix, e.g. `/airport-parking-wizard`. Used when the app is served behind a path-based reverse proxy (e.g. Cloudflare on holidayextras.com). When set, injects `<base href>` and `window._basePath` into the HTML so all assets resolve correctly. Leave unset for direct Heroku URL access. |
| `DATABASE_URL` | _(empty)_ | Postgres connection string. Set automatically by Heroku Postgres. When absent, the app falls back to an in-memory ring buffer for the search log (dev only). |
| `ADMIN_KEY` | _(empty)_ | Shared secret required as `?key=` on `/admin`, `/api/log`, and `/api/log.csv`. When unset, those endpoints are open (dev only — **always set in production**). |

---

## Project Structure

```
parking-wizard/
├── index.html              # Single-page application (all UI + JS)
├── server.js               # Express server — API proxy, parking search, admin dashboard
├── package.json
├── Procfile                # Heroku web dyno declaration
├── LOGIC.md                # Logic engine reference — dates, times, flight logic
├── SKILLS.md               # AI skills reference — API guide for agent-driven bookings
└── public/                 # Static assets — only this directory is HTTP-accessible
    ├── fuse.min.js             # Fuse.js fuzzy search library (vendored)
    ├── nunito-latin.woff2      # Self-hosted font
    ├── logo.webp / logo.png    # Brand assets (WebP primary, PNG fallback)
    ├── get-holiday-ready.*     # Hero images (WebP + JPEG fallback, 824w + full)
    └── mole-favicon-package/   # Favicon assets (multiple sizes + formats)
```

---

## API Reference

### `GET /api/flights`

Proxy to the Holiday Extras flight search API with in-memory caching (4-hour TTL, 500-entry cap with FIFO eviction).

**Query parameters**

| Param | Required | Format | Description |
|---|---|---|---|
| `location` | Yes | 3-letter IATA | Departure airport for outbound; origin airport for return |
| `date` | Yes | `YYYY-MM-DD` | The API filters by **departure date from the origin airport** — not arrival date |
| `destination` | No | 3-letter IATA | Present only for return flight searches; set to the parking airport code |
| `query` | No | string | Free-text filter forwarded to upstream API |

> **Important — return flight date handling:** The API parameter `date` is the *departure* date from the origin airport, not the arrival date at the UK airport. For overnight long-haul flights (e.g. Bangkok→London departing Monday, arriving Tuesday), the client fetches **both the collection date and the day before**, merges the results, and then filters to only show flights whose computed `arrivalDate` matches the date the user tapped. See the client's `_loadReturnFlights()` function.

**Outbound search example**

```
GET /api/flights?location=LGW&date=2026-04-18
```

**Return flight search example**

```
GET /api/flights?location=BKK&date=2026-04-20&destination=LGW
GET /api/flights?location=BKK&date=2026-04-21&destination=LGW
```
*(Both requests are made; results are merged and filtered by arrivalDate)*

**Response**

Raw JSON from the Holiday Extras dock-yard API. The client normalises this with `normaliseFlights()` into a consistent schema (see [Flight Object](#flight-object) below).

**Errors**

| Status | Body | Reason |
|---|---|---|
| `400` | `{ "error": "location and date required" }` | Missing required params |
| `400` | `{ "error": "invalid location" }` | Location not 3 uppercase letters |
| `400` | `{ "error": "invalid date" }` | Date not `YYYY-MM-DD` |
| `400` | `{ "error": "invalid destination" }` | Destination not 3 uppercase letters |
| `502` | `{ "error": "fetch failed" }` | Upstream unreachable |

---

### `POST /api/parking/search`

Accepts a semantic search payload, builds the Holiday Extras redirect URL, logs the search to Postgres, and returns the URL for the client to navigate to.

**Two modes** — the `prefetch` flag controls whether a DB row is written:

- `prefetch: true` — just compute and return `redirectUrl`. No logging. Used by the summary page to warm the redirect target without creating phantom rows on refresh / back-nav.
- `prefetch` absent / false — compute the URL, log the full search entry to Postgres, return the URL. The client fires this with `fetch({ keepalive: true })` on the real "Show prices" click so the POST survives `window.location.href` navigation.

**Request body** (`application/json`)

```json
{
  "agentCode":          "WEB1",
  "visitorId":          "v-abc123xyz",
  "parkingAirport":     "LGW",
  "parkingDropoffDate": "2026-04-18",
  "parkingDropoffTime": "08:00",
  "parkingReturnDate":  "2026-04-25",
  "parkingReturnTime":  "16:00",
  "outboundFlight": {
    "code":              "BA1234",
    "reference":         "BA1234-2026-04-18",
    "departureAirport":  "LGW",
    "departureDate":     "2026-04-18",
    "departureTime":     "10:15",
    "departureTerminal": "N",
    "arrivalAirport":    "MAD",
    "arrivalDate":       "2026-04-18",
    "arrivalTime":       "13:45",
    "dest":              "Madrid Barajas"
  },
  "returnFlight": {
    "code":              "IB3167",
    "reference":         "IB3167-2026-04-25",
    "departureAirport":  "MAD",
    "departureDate":     "2026-04-25",
    "departureTime":     "15:30",
    "departureTerminal": "4",
    "arrivalAirport":    "LGW",
    "arrivalDate":       "2026-04-25",
    "arrivalTime":       "17:20",
    "arrivalTerminal":   "N"
  },
  "prefetch": false
}
```

| Field | Required | Description |
|---|---|---|
| `agentCode` | No | HX agent code — read from `agent` URL param, sessionStorage, or cookie, in that order. Controls product visibility and pricing on the HX results page. Defaults to `WEB1` if absent. |
| `visitorId` | No | Stable per-browser ID (localStorage). Logged for analytics. |
| `authToken` | No (server-read) | HX auth token. The browser sends this as an HttpOnly cookie (`auth_token`); the server reads it from the request's `Cookie` header. Client-supplied `authToken` in the body is used only as a fallback on environments where the cookie isn't set. |
| `prefetch` | No | When `true`, skip all logging and just return `redirectUrl`. |
| `parkingAirport` | Yes | 3-letter IATA code of the parking airport |
| `parkingDropoffDate` | Yes | Date the car is dropped off (`YYYY-MM-DD`) |
| `parkingDropoffTime` | Yes | Time the car is dropped off (`HH:MM`, 24-hour; may be `00:01` or `23:59`) |
| `parkingReturnDate` | Yes | Date the car is collected (`YYYY-MM-DD`) |
| `parkingReturnTime` | Yes | Time the car is collected (`HH:MM`, 24-hour; may be `00:01` or `23:59`) |
| `outboundFlight` / `returnFlight` | No | Full flight objects as produced by the client's `normaliseFlights()`. All inner fields are optional — the server persists whatever is supplied. |

**Response**

```json
{
  "redirectUrl": "https://www.holidayextras.com/static/?selectProduct=cp&reloadKey=d1b72610#/categories?agent=WEB1&depart=LGW&out=2026-04-18&park_from=08%3A00&in=2026-04-25&park_to=16%3A00&flight=BA1234&terminal=N&redirectReferal=carpark&from_categories=true"
}
```

**Errors**

| Status | Body | Reason |
|---|---|---|
| `400` | `{ "error": "missing required parking fields" }` | One or more required parking fields absent |

---

### `GET /api/log` *(auth-gated)*

Returns the Postgres-backed search log as JSON. Rolling **24-hour window** by default; paginated with `?limit=` and `?offset=` (default 500 / 0).

Auth: append `?key=$ADMIN_KEY`. Returns `401` otherwise when `ADMIN_KEY` is set.

⚠️ **Contains PII** — the `authToken` and `visitorId` fields identify authenticated Holiday Extras customers. This endpoint is locked down in production and the downstream team consumes it indirectly via the planned webhook.

**Response**

```json
{
  "total":  342,
  "limit":  500,
  "offset": 0,
  "rows": [
    {
      "ts":                        "2026-04-18T07:30:00.000Z",
      "agentCode":                 "WEB1",
      "visitorId":                 "v-abc123xyz",
      "authToken":                 "BAh7CkkiD3Nlc3Npb25faWQ...==--abc123",
      "parkingAirport":            "LGW",
      "nights":                    7,
      "parkingDropoffDate":        "2026-04-18",
      "parkingDropoffTime":        "08:00",
      "parkingReturnDate":         "2026-04-25",
      "parkingReturnTime":         "16:00",
      "outboundFlight":            "BA1234",
      "outboundReference":         "BA1234-2026-04-18",
      "outboundDepartureAirport":  "LGW",
      "outboundDepartureDate":     "2026-04-18",
      "outboundDepartureTime":     "10:15",
      "outboundDepartureTerminal": "N",
      "outboundArrivalAirport":    "MAD",
      "outboundArrivalDate":       "2026-04-18",
      "outboundArrivalTime":       "13:45",
      "outboundDest":              "Madrid Barajas",
      "returnFlight":              "IB3167",
      "returnReference":           "IB3167-2026-04-25",
      "returnDepartureAirport":    "MAD",
      "returnDepartureDate":       "2026-04-25",
      "returnDepartureTime":       "15:30",
      "returnDepartureTerminal":   "4",
      "returnArrivalAirport":      "LGW",
      "returnArrivalDate":         "2026-04-25",
      "returnArrivalTime":         "17:20",
      "returnArrivalTerminal":     "N",
      "returnOrigin":              "MAD",
      "redirectUrl":               "https://www.holidayextras.com/static/?..."
    }
  ]
}
```

---

### `GET /api/log.csv` *(auth-gated)*

CSV export of **all** search log rows (not limited to 24h). Up to 5000 rows. Auth: `?key=$ADMIN_KEY`. Download filename: `parking-searches-YYYY-MM-DD.csv`.

---

### `GET /admin` *(auth-gated)*

Live HTML dashboard for the last 24h of searches. Click-to-copy visitor IDs and auth tokens; free-text filter; direct links to the JSON and CSV endpoints. Auth: `?key=$ADMIN_KEY`.

---

## Flight Object

After normalisation on the client, each flight has this shape:

```js
{
  code:          "BA1234",          // Primary IATA flight code
  airline:       "British Airways",
  airlineCode:   "BA",
  dest:          "Madrid Barajas",  // Destination airport name
  destCity:      "Madrid",          // Destination city (shown on second line in picker)
  destCountry:   "Spain",
  destAirport:   "MAD",             // Destination IATA code
  origin:        "London Gatwick",
  originAirport: "LGW",
  depHour:       10,                // Departure hour (0–23)
  depMinute:     15,                // Departure minute
  hour:          13,                // Arrival hour at destination
  minute:        45,                // Arrival minute
  terminal:      "N",               // Departure/arrival terminal
  isCodeshare:   false,
  operatedBy:    null,              // Actual carrier if codeshare
  departureDate: "2026-04-18",      // ISO date of departure from origin
  arrivalDate:   "2026-04-18",      // ISO date of arrival at destination (may differ for overnight flights)
  tailfin:       "https://…",       // Airline tailfin image URL
  _raw:          { /* original upstream payload */ }
}
```

`arrivalDate` is computed client-side: if the arrival time is earlier than the departure time (clock crosses midnight), the arrival date is set to departureDate + 1 day.

Codeshare flights are grouped into a single display row, with the operating carrier shown as the primary entry.

---

## User Flow

```
Step 1  Airport selection
        → IP geolocation fires immediately on load
        → GPS runs in parallel and upgrades the sort order silently if granted
        → Airports sorted by distance; recents shown at top

Step 2  Drop-off date
        → Calendar picker (today + up to 710 days ahead)

Step 3  Outbound flight  (skippable — Skip button sits on the title line)
        → Flights fetched from /api/flights for selected airport + date
        → Full-text search across airline, destination, city, flight code
        → City name shown on second line of each flight row
        → Recent/favourite flights highlighted

Step 4  Drop-off time
        → 25 options: 00:01, 01:00–23:00, 23:59
        → Suggested time = flight departure time minus 3 hours (minimum 00:01)
        → Green hint bar shows flight code, departure time, date, airport, terminal
        → Tip box explains grace periods and Overstay Waiver

Step 5  Return date
        → Calendar picker (min: day after drop-off, max: +100 days)

Step 6  Return flight  (skippable — Skip button sits on the title line)
        → Two date tabs: [day before collection date] and [collection date]
        → Tabs represent ARRIVAL dates at the parking airport
        → Both dates are fetched from the API; results merged and filtered by arrivalDate
        → Overnight long-haul flights (e.g. Bangkok→London) appear under the correct landing date
        → No-results message names the specific airport and date; hints at adjacent-date check
        → Same search/filter UI as Step 3

Step 7  Return time  (question includes the collection date for clarity)
        → Same 25-option picker as Step 4
        → If flight lands on the day BEFORE the collection date:
            - lands 23:xx → suggest (hour + 2) % 24 (wraps to early morning)
            - lands earlier → suggest 00:01 (start of collection day)
        → If flight lands on the collection date: suggest landing time + 2 hours
        → Green hint bar shows flight code, landing time, date, airport, terminal
        → Tip box explains grace periods and Overstay Waiver

Step 8  Review & submit
        → Summary of all selections with natural-language dates and formatted times
        → POST /api/parking/search with { prefetch:true } on page render — warms the redirectUrl, no DB row
        → On confirm: fire a keepalive POST (same payload, no prefetch flag) to log, then navigate to redirectUrl
```

---

## Deployment

The app ships a `Procfile` for Heroku:

```
web: node server.js
```

Any platform that runs `node server.js` and exposes a `PORT` environment variable will work (Railway, Render, Fly.io, etc.).

Static assets (images, fonts, fuse.js) live in `public/` and are served with a 30-day `Cache-Control` header. `index.html` is served with `no-cache` so deployments take effect immediately. Keeping assets in `public/` means `server.js`, `package.json`, and other root files are never HTTP-accessible.

A `heroku-postbuild` npm script runs `html-minifier-terser` to minify the JS and CSS inside `index.html` before the dyno starts. Flags used: `--minify-js '{"compress":false,"mangle":false}'` — compression is disabled to avoid code transformations that could affect GPS/geolocation callbacks; mangling is disabled to preserve function names used in inline `onclick` handlers.

**Live deployment:**

| App | Region | URL | Used by |
|---|---|---|---|
| `parking-wizard-hx-eu` | EU (Dublin) | `https://parking-wizard-hx-eu-a0df79b1e7b3.herokuapp.com/` | Production — 4 standard-2x dynos, path-proxied via Cloudflare at `holidayextras.com/airport-parking-wizard/`, dedicated Heroku Postgres essential-0 |

**Tail live logs:**
```bash
heroku logs --tail --app parking-wizard-hx-eu
```

**Run ad-hoc DB commands:**
```bash
heroku run --app parking-wizard-hx-eu node -e "..."
```

---

## Local Development Tips

- **Flight data is cached for 4 hours** (500-entry cap; capped entries are FIFO-evicted). Restart the server to bust the cache during development.
- **Back-button support** — the wizard saves state to `sessionStorage`, so a full page reload is needed to reset the flow during testing.
- **No build step locally** — edit `index.html` or `server.js` and refresh. Minification only runs on Heroku.
- **GPS on localhost** — browsers may block geolocation on plain `http://`. Use Chrome's localhost exception or test on a deployed URL.

---

## Upstream Dependencies

| Service | Purpose |
|---|---|
| `holidayextras.com/dock-yard/flight/search` | Live flight data API |
| `ipapi.co/json/` | IP-based geolocation (fires immediately on load) |
| HX Tracker v6 (CloudFront CDN) | Analytics / event tracking |

---

## Future Ideas

### Push searches downstream via webhook

The downstream "trip" team needs each parking search (auth token + flight details + parking window) so they can create / enrich a trip and start messaging the customer about other products. Current plan — **fire-and-forget webhook** from `parkingSearchHandler` after the Postgres insert:

```
POST https://trip-team.holidayextras.com/hooks/parking-search
X-Webhook-Secret: <shared secret in Heroku config>
Content-Type: application/json

<the full search entry — same shape as a row from /api/log>
```

Webhook over pub/sub queue because: simple, one consumer, 10-minute downtime is fine (searches are not mission-critical), no new infra. If throughput ever becomes a problem or a second consumer appears, swap to SNS/SQS or Heroku Redis.

### Return from a different airport (open jaw)

**The scenario:** Customer flies Gatwick → Alicante but returns Malaga → Gatwick. Step 6 currently hardcodes the outbound destination (Alicante) as the return search origin.

**What's shipped:** A "Returning from a different airport?" link appears on step 6, below the route context line. Clicking it skips the return flight step (same as Skip), so the customer can continue to pick their car collection time manually. Simple, no dead ends.

**The next step — all-inbound endpoint:** The HX flight search API supports fetching every flight arriving at an airport on a given date without specifying an origin:

```
GET /dock-yard/flight/search?query=&location=&arrivalDate=YYYY-MM-DD&destination=LGW
```

Leaving `location` empty returns all inbound flights to `destination` on that date. This is the missing piece for a proper open jaw flight picker — add a `/api/flights/inbound?destination=LGW&date=YYYY-MM-DD` server endpoint that calls this, and the full inbound list becomes available to the client.

**The geolocation filter:** A raw inbound list for a hub like Gatwick can be 300–400 flights from all over the world. Filter by proximity of the origin airport to the customer's outbound destination:

- The UK airport list already stores lat/lon. Build a modest overseas airport coordinate dataset (~500 airports covers 99% of charter/scheduled routes from UK airports).
- Calculate distance between `state.dropoffFlight.destAirport` and each inbound flight's origin airport.
- Show only flights departing within ~500 km. Someone flying Gatwick → Alicante isn't returning from Los Angeles.
- Provide an "show all airports" fallback for edge cases.

**UI:** Render the filtered inbound list using the existing return flight two-leg row format (dep time + origin code → arr time + parking airport). The existing search/filter box handles narrowing it further.

---

## Further Reading

- **[LOGIC.md](LOGIC.md)** — Deep-dive into all the non-obvious date, time and flight logic: the airport-hotel pre-night scenario, why the return flight step fetches two days from the API, the overnight time-wrap calculation, sentinel values, and more. Essential reading before touching any date or time code.
- **[SKILLS.md](SKILLS.md)** — API reference for AI agents: how to search for outbound and return flights, submit a parking search, and chain the skills into a complete end-to-end booking.

---

## License

Internal Holiday Extras project.
