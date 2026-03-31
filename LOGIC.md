# Parking Wizard — Logic Engine Reference

> **Audience:** Developers picking this up after the initial prototype. This document explains the non-obvious date, time and flight logic so you don't have to reverse-engineer it from the code.

---

## Overview

The parking wizard is an 8-step flow that collects everything needed to search for airport parking. The trickiest parts are all date/time related: flights land on different days to when they depart, customers sometimes park the night before their flight, and "what time should we suggest?" requires knowing about overnight wraps past midnight.

---

## The 8-Step Flow

| Step | Hash | What it does | State field set |
|------|------|--------------|-----------------|
| 1 | `#flying-from` | Pick airport (with GPS/IP assist) | `state.airport` |
| 2 | `#parking-from` | Pick car drop-off date | `state.dropoffDate` |
| 3 | `#outbound-flight` | Find & pick outbound flight (optional) | `state.dropoffFlight` |
| 4 | `#dropoff-time` | Pick what time to drop the car off | `state.dropoffTime` |
| 5 | `#return-date` | Pick car collection date | `state.returnDate` |
| 6 | `#return-flight` | Find & pick return flight (optional) | `state.returnFlight` |
| 7 | `#return-time` | Pick what time to collect the car | `state.returnTime` |
| 8 | `#search-summary` | Review everything, then search | — (redirects to HX) |

The hero image is only shown on step 1. Every other step hides it to give the form more room. Steps 3 and 6 can both be skipped — the flight info just pre-fills the time suggestions on steps 4 and 7.

---

## State Object

```js
const state = {
    airport:       null,  // { code, short, full, lat, lon }
    dropoffDate:   null,  // Date — when the car is parked
    dropoffTime:   null,  // integer — hour (0–23) or sentinel (-1 = 00:01, 24 = 23:59)
    dropoffFlight: null,  // flight object or null if skipped
    returnDate:    null,  // Date — when the car is collected
    returnTime:    null,  // integer — hour (0–23) or sentinel (-1 = 00:01, 24 = 23:59)
    returnFlight:  null,  // flight object or null if skipped
};
```

---

## Time Picker & Sentinel Values

The time picker shows 25 buttons: **00:01, 01:00, 02:00 … 23:00, 23:59**.

Internally, times are stored as integers, but two special sentinel values handle the extremes:

| Stored value | Displayed as | Why |
|---|---|---|
| `-1` | `00:01` | "Just after midnight" — useful for very early morning drop-offs |
| `24` | `23:59` | "Just before midnight" — useful for late-night collections |
| `1`–`23` | `01:00`–`23:00` | Normal hours on the hour |

`00:00` is intentionally excluded — it's ambiguous between "start of day" and "end of day" and causes confusion in parking system date ranges.

The `fmtTime(t)` helper converts a stored value to a display string:
```js
function fmtTime(t) {
    if (t === -1) return '00:01';
    if (t === 24) return '23:59';
    return pad2(t) + ':00';
}
```

---

## The Airport Hotel / Pre-Night Parking Scenario

This is the most important thing to understand about why **the drop-off date can be before the departure date.**

Many HX customers book an airport hotel the night before their flight. The hotel deal often includes parking. So the workflow is:

1. **Day 1 (eve)** — Customer drives to airport, checks into hotel, parks their car
2. **Day 2 (morning)** — Customer takes their bags to the terminal and flies
3. **Day N (return)** — Flight lands, customer retrieves their car from the hotel car park

In the wizard, the user picks **when they park the car** on step 2 and **when their flight departs** on step 3. These can be on different days — the calendar on step 2 allows any date from today up to 365 days ahead with no constraint relating to the flight.

The outbound flight step then shows a **2-tab date strip** (the drop-off date and the following day) precisely to handle this:
- If parking on Monday night → show outbound flights for both Monday and Tuesday
- The flight will typically be on Tuesday, but showing both avoids confusion

---

## Outbound Flight Date Strip

**2 tabs**: drop-off date (offset `0`) and the next day (offset `+1`).

```
Example: user parked on Mon 14 Apr
  Tab 1: Mon 14 Apr  ← departures on the parking day itself (unusual but valid)
  Tab 2: Tue 15 Apr  ← departures the morning after (the common airport hotel case)
```

The API is called with the selected tab's date as the departure date. Results are straightforward: flights departing on that date from the chosen airport.

---

## Return Flight Date Strip & The Two-Day Fetch Problem

This is the most complex part of the logic engine.

### The problem

The HX flights API filters by **departure date from the origin airport** (i.e. where you're flying from on holiday). But the user wants to see flights by **arrival date at their home airport**. These are different dates for any flight that crosses midnight.

**Example:**
- User is in Nice, flying back to Gatwick
- User selected collection date: **Saturday 18 Apr**
- Flight departs Nice **Friday 17 Apr at 23:40**, arrives Gatwick **Saturday 18 Apr at 01:10**
- If we only query the API for departures on Saturday 18 Apr, we **miss this flight entirely**

### The solution: fetch two days, filter by arrival

The `_loadReturnFlights()` function makes **two parallel API calls**:
1. Flights departing from the holiday destination on **`returnDate - 1 day`** (the day before)
2. Flights departing from the holiday destination on **`returnDate`** (collection date itself)

Then it merges both lists (deduplicating by flight identity), and applies a final filter:

```js
.filter(f => (f.arrivalDate || f.departureDate) === targetDateStr)
```

This keeps only flights that **land on the target date**, regardless of when they took off. The fallback to `f.departureDate` handles short-haul domestic flights that don't have a separate `arrivalDate` in the API response (they depart and arrive on the same day).

### The date strip

**2 tabs**: the day before the collection date (offset `-1`) and the collection date itself (offset `0`).

```
Example: user collecting on Sat 18 Apr
  Tab 1: Fri 17 Apr  ← flights that depart Thu/Fri but land Fri (overnight from further away)
  Tab 2: Sat 18 Apr  ← flights that depart Fri/Sat and land Sat (the common case)
```

There is deliberately no `+1` tab. A flight that lands the day after the user's collection date would mean the car needs to be there before the customer — logistically nonsensical.

### Why not just query by arrival date?

The HX API does not support filtering by arrival date. It only accepts a departure date. This two-day-fetch-and-filter pattern is the workaround.

---

## Drop-off Time Suggestion (Step 4)

When a user picks an outbound flight on step 3, step 4 pre-selects a sensible drop-off time:

```js
Math.max(-1, state.dropoffFlight.hour - 3)
```

**Subtract 3 hours from the flight's departure time.** The floor of `-1` prevents the suggestion going below 00:01.

| Flight departs | Suggested drop-off |
|---|---|
| 10:00 | 07:00 |
| 06:00 | 03:00 |
| 02:00 | 00:01 (sentinel -1) |
| 01:00 | 00:01 (sentinel -1) |

The 3-hour buffer is the standard international check-in and security allowance. For domestic flights this is generous, but it's better to over-estimate than to suggest the customer cuts it fine.

---

## Return Time Suggestion (Step 7) — The Overnight Wrap

When a user picks a return flight on step 6, step 7 pre-selects a sensible collection time. This is where the overnight logic lives.

### Same-day case (flight lands on the collection date)

```js
Math.min(23, f.hour + 2)
```

Add 2 hours to the landing time (for deplaning, customs, baggage, getting to the car park). Cap at 23 to avoid the `24` sentinel being suggested by default.

| Flight lands | Suggested collection |
|---|---|
| 14:30 | 16:00 |
| 21:00 | 23:00 |
| 22:30 | 23:00 (capped) |

### Overnight case (flight lands the day before the collection date)

This happens when the user has set their collection date to the day after their flight lands — for example, a flight that lands at 23:30 and they want to collect their car in the morning.

```js
const isOvernightPickup = landingDateStr < collectionDateStr;

if (isOvernightPickup) {
    return (f.hour + 2 >= 24) ? (f.hour + 2) % 24 : -1;
}
```

Two sub-cases:

**Sub-case A: Flight lands close to midnight, +2h crosses into the next day**

```
Flight lands: 23:00 Mon → +2h = 25 → wraps to 01:00 Tue
Flight lands: 22:30 Mon → +2h = 24 (sentinel) → 23:59 Mon... but that's before landing

Actually: 22:00 → 24 ≥ 24 → (22+2)%24 = 0 → displayed as 00:00...
```

More precisely: `(f.hour + 2) % 24` gives the early-morning hour on collection day.

| Landing time | hour + 2 | Suggested collection on NEXT day |
|---|---|---|
| 23:00 | 25 | (25 % 24) = 01:00 |
| 22:00 | 24 | (24 % 24) = 00:00 → sentinel `-1` = 00:01 |

**Sub-case B: Flight lands early enough that +2h stays in the landing day's evening**

If a flight lands at 17:00 but the user chose to collect the car the next morning, adding 2 hours gives 19:00 — which is on the landing day, not the collection day. Suggesting "19:00" on a collection day that starts at midnight would be confusing.

In this case, default to `00:01` (sentinel `-1`) — the earliest sensible start to the collection day.

### Full `_returnSuggestedHour()` function

```js
function _returnSuggestedHour() {
    const f = state.returnFlight;
    if (!f) return state.returnTime;

    const landingDateStr    = f.arrivalDate || f.departureDate || '';
    const collectionDateStr = state.returnDate ? fmtISO(state.returnDate) : '';
    const isOvernightPickup = landingDateStr && collectionDateStr && landingDateStr < collectionDateStr;

    if (isOvernightPickup) {
        return (f.hour + 2 >= 24) ? (f.hour + 2) % 24 : -1;
    }
    return Math.min(23, f.hour + 2);
}
```

---

## Date Formatting Reference

Four formatting functions are used throughout the UI:

| Function | Output format | Example | Used where |
|---|---|---|---|
| `fmtShort(d)` | `DDD DD MMM` | `Mon 14 Apr` | Date strip tabs, flight hints |
| `fmtDisplay(d)` | `DDD DD MMM YYYY` | `Mon 14 Apr 2026` | Return date context line |
| `fmtNatural(d)` | `DDDDDD DDth MMMMM YYYY` | `Monday 14th April 2026` | Step 8 review card |
| `fmtISO(d)` | `YYYY-MM-DD` | `2026-04-14` | API calls, date comparisons |

Ordinal suffixes (1st, 2nd, 3rd, 4th…) handle the 11th/12th/13th exception correctly.

---

## Agent Code

When the wizard runs embedded on `holidayextras.com`, the HX `agent` cookie is present (e.g. `agent=WEB1`). The agent code controls which products are shown and what prices are applied in the search results.

The client reads it on submission:
```js
function _getAgentCode() {
    const c = document.cookie.split(';').map(s => s.trim()).find(s => /^agent=/i.test(s));
    return c ? c.split('=').slice(1).join('=').toUpperCase() : '';
}
```

It's included in the `POST /api/parking/search` payload as `agentCode`, threaded into the HX search URL as `&agent=WEB1`, and written to the server-side search log. When accessed directly via the Heroku URL (no HX cookies), it falls back to `WEB1`.

---

## Edge Cases & Known Gotchas

### 1. Duplicate `agent` cookies
HX sets `agent=WEB1` twice — once at the root path and once at the `/parking-wizard/` path. `document.cookie` returns both. The code takes the first match and uppercases it, which is safe.

### 2. Flights with no `arrivalDate`
Short-haul domestic flights in the HX API often have no `arrivalDate` field — they're assumed to arrive on the same day. The return flight filter uses `f.arrivalDate || f.departureDate` as a fallback, which means these flights show correctly on the departure-date tab.

### 3. The 15-second GPS timeout
On desktop machines without a GPS chip, `getCurrentPosition({ enableHighAccuracy: true })` often fails with `POSITION_UNAVAILABLE` (error code 2). The code retries automatically with `enableHighAccuracy: false` (WiFi/OS network location), which usually succeeds on laptops. If both fail, IP-based location handles airport sorting silently.

### 4. Return date minimum
The return date picker enforces a minimum of `dropoffDate + 1 day`. You cannot collect the car on the same day you drop it off. This is a product constraint from the parking suppliers, not just a UX decision.

### 5. Path-based routing and `<base href>`
When served via `holidayextras.com/parking-wizard/`, Express injects `<base href="/parking-wizard/">` into the HTML so all relative asset URLs resolve correctly. This injection is gated on `req.baseUrl` being non-empty — direct Heroku URL access never gets the tag, which matters because `<base href>` was found to interfere with GPS permission detection in some browsers.

### 6. Flight cache
Fetched flight data is cached in memory (`_flightCache`) for the session. Date-strip tab switching is therefore instant for already-fetched dates. The cache is also pre-warmed: when step 3 loads, it immediately fetches the next day's flights in the background so tab-switching feels instant.

---

## API Endpoints (Server)

| Method | Path | What it does |
|---|---|---|
| `GET` | `/api/flights?location=LGW&date=2026-04-14` | Proxy to HX flights API; cached 5 min |
| `GET` | `/api/flights?location=LGW&date=2026-04-14&destination=NCE` | Return flights (inbound direction) |
| `POST` | `/api/parking/search` | Build HX search URL, log search, return `{ redirectUrl }` |
| `GET` | `/api/log` | Last 200 searches (no PII) |

---

## Files

```
parking-wizard/
├── index.html     — entire front-end (HTML + CSS + JS, single file, minified on deploy)
├── server.js      — Express server: flight proxy, search endpoint, search log
├── package.json   — Node deps (express, compression, html-minifier-terser)
├── Procfile       — Heroku: web: node server.js
└── LOGIC.md       — this document
```

The single-file frontend is intentional for this prototype stage — no build tooling, no bundler, deployable as-is. The `heroku-postbuild` script minifies `index.html` with `html-minifier-terser` (JS compress and mangle both disabled to keep function names intact for the inline event handlers).
