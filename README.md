# Parking Wizard

A streamlined, mobile-first booking wizard for Holiday Extras airport parking. Guides users through an 8-step flow — airport, dates, times, and optional outbound/return flights — then hands them off to the Holiday Extras checkout with all search parameters pre-filled.

---

## Features

- **8-step guided wizard** — airport → drop-off date → outbound flight → drop-off time → return date → return flight → return time → review & submit
- **GPS + IP location detection** — sorts airports by proximity on first load
- **Flight search** — live flight data with full-text search (Fuse.js), codeshare deduplication, and recent/favourite flights
- **Smart time defaults** — pre-selects recommended drop-off/return times based on flight schedule
- **Recents & favourites** — airports and flights persist in localStorage for quick repeat bookings
- **Seamless HX handoff** — submits to Holiday Extras with all parameters serialised into the correct URL format
- **Server-side flight caching** — 4-hour in-memory cache on the proxy layer to reduce upstream API calls

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, HTML5, CSS3 (single-page, no framework) |
| Search | [Fuse.js](https://fusejs.io/) v7 (client-side fuzzy search) |
| Font | Nunito (self-hosted WOFF2) |
| Backend | Node.js 20 + Express 4 |
| Compression | gzip/Brotli via `compression` middleware |
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

---

## Project Structure

```
parking-wizard/
├── index.html              # Single-page application (all UI + JS)
├── server.js               # Express server — API proxy + parking search
├── package.json
├── Procfile                # Heroku web dyno declaration
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
| `date` | Yes | `YYYY-MM-DD` | Departure date (outbound) or arrival date (return) |
| `destination` | No | 3-letter IATA | Present only for return flight searches; set to the parking airport code |
| `query` | No | string | Free-text filter forwarded to upstream API |

**Outbound search example**

```
GET /api/flights?location=LGW&date=2026-04-18
```

**Return flight search example**

```
GET /api/flights?location=ALC&date=2026-04-25&destination=LGW
```

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
| `parkingAirport` | Yes | 3-letter IATA code of the parking airport |
| `parkingDropoffDate` | Yes | Date the car is dropped off (`YYYY-MM-DD`) |
| `parkingDropoffTime` | Yes | Time the car is dropped off (`HH:MM`, 24-hour) |
| `parkingReturnDate` | Yes | Date the car is collected (`YYYY-MM-DD`) |
| `parkingReturnTime` | Yes | Time the car is collected (`HH:MM`, 24-hour) |
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

The client navigates to `redirectUrl`, landing the user on the Holiday Extras product selection page with all fields pre-filled.

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
  code:          "BA1234",       // Primary IATA flight code
  airline:       "British Airways",
  airlineCode:   "BA",
  dest:          "Madrid",       // Destination city name
  destAirport:   "MAD",          // Destination IATA code
  origin:        "London Gatwick",
  originAirport: "LGW",
  depHour:       10,             // Departure hour (0–23)
  depMinute:     15,             // Departure minute
  hour:          13,             // Arrival hour
  minute:        45,             // Arrival minute
  terminal:      "N",            // Departure terminal
  isCodeshare:   false,
  operatedBy:    null,           // Actual carrier if codeshare
  departureDate: "2026-04-18",
  arrivalDate:   "2026-04-18",
  _raw:          { /* original upstream payload */ }
}
```

Codeshare flights are grouped into a single display row, with the operating carrier shown as the primary entry.

---

## User Flow

```
Step 1  Airport selection
        → GPS permission prompt → IP geolocation fallback → default UK centre
        → Airports sorted by distance; recents shown at top

Step 2  Drop-off date
        → Calendar picker (today + up to 365 days ahead)

Step 3  Outbound flight  (skippable)
        → Flights fetched from /api/flights for selected airport + date
        → Full-text search across airline, destination, flight code
        → Recent/favourite flights highlighted

Step 4  Drop-off time
        → 24 hourly buttons; recommended time pre-highlighted based on flight

Step 5  Return date
        → Calendar picker (min: day after drop-off, max: +100 days)

Step 6  Return flight  (skippable)
        → Flights fetched from /api/flights for destination airport + return date
        → Same search/filter UI as Step 3

Step 7  Return time
        → Same time picker; recommended time pre-highlighted based on return flight

Step 8  Review & submit
        → Summary of all selections
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

---

## Local Development Tips

- **Flight data is cached for 4 hours.** Restart the server to bust the cache during development.
- **Back-button support** — the wizard saves state to `sessionStorage`, so a full page reload is needed to reset the flow during testing.
- **No build step** — edit `index.html` or `server.js` and refresh.

---

## Upstream Dependencies

| Service | Purpose |
|---|---|
| `holidayextras.com/dock-yard/flight/search` | Live flight data API |
| `ipapi.co/json/` | IP-based geolocation fallback |
| HX Tracker v6 (CloudFront CDN) | Analytics / event tracking |

---

## License

Internal Holiday Extras project.
