# Parking Wizard

A streamlined, mobile-first booking wizard for Holiday Extras airport parking. Guides users through an 8-step flow — airport, dates, times, and optional outbound/return flights — then hands them off to the Holiday Extras checkout with all search parameters pre-filled.

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
- **HX agent code** — reads the `agent` cookie set by holidayextras.com and passes it through the search payload to control product visibility and pricing on the results page
- **Server-side flight caching** — 4-hour in-memory cache on the proxy layer to reduce upstream API calls
- **JS/CSS minification** — `html-minifier-terser` runs as a `heroku-postbuild` step, saving ~5 KiB on every deploy
- **iPhone safe-area support** — `viewport-fit=cover` + `env(safe-area-inset-top)` for PWA/home-screen installs

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 (single-page, no framework) |
| Search | [Fuse.js](https://fusejs.io/) v7 (client-side fuzzy search) |
| Font | Nunito (self-hosted WOFF2) |
| Backend | Node.js 20 + Express 4 |
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
| `MOUNT_PATH` | _(empty)_ | Optional sub-path prefix, e.g. `/parking-wizard`. Used when the app is served behind a path-based reverse proxy (e.g. Cloudflare on holidayextras.com). When set, injects `<base href>` and `window._basePath` into the HTML so all assets resolve correctly. Leave unset for direct Heroku URL access. |

---

## Project Structure

```
parking-wizard/
├── index.html              # Single-page application (all UI + JS)
├── server.js               # Express server — API proxy + parking search
├── package.json
├── Procfile                # Heroku web dyno declaration
├── LOGIC.md                # Logic engine reference — dates, times, flight logic
├── SKILLS.md               # AI skills reference — API guide for agent-driven bookings
├── fuse.min.js             # Fuse.js fuzzy search library (vendored)
├── nunito-latin.woff2      # Self-hosted font
├── logo.png / logo.jpg     # Brand assets
├── get-holiday-ready.*     # Hero images (WebP + JPEG fallback)
└── mole-favicon-package/   # Favicon assets (multiple sizes + formats)
```

---

## API Reference

### `GET /api/flights`

Proxy to the Holiday Extras flight search API with in-memory caching (4-hour TTL).

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

Accepts a semantic search payload, builds the Holiday Extras redirect URL, logs the search, and returns the URL for the client to navigate to.

**Request body** (`application/json`)

```json
{
  "agentCode":         "WEB1",
  "parkingAirport":    "LGW",
  "parkingDropoffDate": "2026-04-18",
  "parkingDropoffTime": "08:00",
  "parkingReturnDate":  "2026-04-25",
  "parkingReturnTime":  "16:00",
  "outboundFlight": {
    "code":               "BA1234",
    "departureTerminal":  "N",
    "arrivalAirport":     "MAD"
  },
  "returnFlight": {
    "code":               "IB3167",
    "arrivalTerminal":    "N",
    "departureAirport":   "MAD"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `agentCode` | No | HX agent code read from the `agent` cookie (e.g. `WEB1`). Controls which products are shown and pricing applied on the HX results page. Defaults to `WEB1` if absent. |
| `parkingAirport` | Yes | 3-letter IATA code of the parking airport |
| `parkingDropoffDate` | Yes | Date the car is dropped off (`YYYY-MM-DD`) |
| `parkingDropoffTime` | Yes | Time the car is dropped off (`HH:MM`, 24-hour; may be `00:01` or `23:59`) |
| `parkingReturnDate` | Yes | Date the car is collected (`YYYY-MM-DD`) |
| `parkingReturnTime` | Yes | Time the car is collected (`HH:MM`, 24-hour; may be `00:01` or `23:59`) |
| `outboundFlight` | No | Selected outbound flight object |
| `outboundFlight.code` | No | IATA flight code, e.g. `BA1234` |
| `outboundFlight.departureTerminal` | No | Terminal letter/number, e.g. `N`, `S`, `2` |
| `outboundFlight.arrivalAirport` | No | Destination airport IATA code |
| `returnFlight` | No | Selected return flight object |
| `returnFlight.code` | No | IATA flight code |
| `returnFlight.arrivalTerminal` | No | Arrival terminal at parking airport |
| `returnFlight.departureAirport` | No | Departure airport IATA code |

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

### `GET /api/log`

Returns the rolling in-memory log of the last 200 parking searches. No PII is stored — only airport codes, dates, times, flight codes, and terminals.

**Response**

```json
[
  {
    "ts":                       "2026-04-18T07:30:00.000Z",
    "agentCode":                 "WEB1",
    "parkingAirport":            "LGW",
    "nights":                    7,
    "parkingDropoffDate":        "2026-04-18",
    "parkingDropoffTime":        "08:00",
    "parkingReturnDate":         "2026-04-25",
    "parkingReturnTime":         "16:00",
    "outboundFlight":            "BA1234",
    "outboundDepartureTerminal": "N",
    "returnFlight":              "IB3167",
    "returnArrivalTerminal":     "N"
  }
]
```

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
        → Calendar picker (today + up to 365 days ahead)

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
        → POST /api/parking/search in background (prefetch)
        → On confirm: navigate to redirectUrl
```

---

## Deployment

The app ships a `Procfile` for Heroku:

```
web: node server.js
```

Any platform that runs `node server.js` and exposes a `PORT` environment variable will work (Railway, Render, Fly.io, etc.).

Static assets (images, fonts, fuse.js) are served with a 30-day `Cache-Control` header. `index.html` is served with `no-cache` so deployments take effect immediately.

A `heroku-postbuild` npm script runs `html-minifier-terser` to minify the JS and CSS inside `index.html` before the dyno starts. Flags used: `--minify-js '{"compress":false,"mangle":false}'` — compression is disabled to avoid code transformations that could affect GPS/geolocation callbacks; mangling is disabled to preserve function names used in inline `onclick` handlers.

**Live deployments:**

| App | Region | URL | Used by |
|---|---|---|---|
| `parking-wizard-hx-eu` | EU (Dublin) | `https://parking-wizard-hx-eu-a0df79b1e7b3.herokuapp.com/` | Production — path-proxied via Cloudflare at `holidayextras.com/parking-wizard/` |
| `parking-wizard-hx` | US | `https://parking-wizard-hx-e29e0d876ce4.herokuapp.com/` | Backup / staging |

**Tail live logs:**
```bash
heroku logs --tail --app parking-wizard-hx-eu
```

---

## Local Development Tips

- **Flight data is cached for 4 hours.** Restart the server to bust the cache during development.
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

## Further Reading

- **[LOGIC.md](LOGIC.md)** — Deep-dive into all the non-obvious date, time and flight logic: the airport-hotel pre-night scenario, why the return flight step fetches two days from the API, the overnight time-wrap calculation, sentinel values, and more. Essential reading before touching any date or time code.
- **[SKILLS.md](SKILLS.md)** — API reference for AI agents: how to search for outbound and return flights, submit a parking search, and chain the skills into a complete end-to-end booking.

---

## License

Internal Holiday Extras project.
