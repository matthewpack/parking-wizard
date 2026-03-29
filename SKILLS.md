# Parking Wizard — AI Skills Reference

This document gives an AI assistant everything it needs to recreate a flight search and parking booking search using the Parking Wizard API. All endpoints are local to the running Express server.

---

## Prerequisites

The Parking Wizard server must be running:

```bash
npm install && npm start   # listens on http://localhost:8080
```

All endpoints below are relative to `http://localhost:8080`.

---

## Skill 1 — Search for Outbound Flights

**Goal:** Given a parking airport and a drop-off date, return a list of flights departing from that airport on that date.

### Endpoint

```
GET /api/flights
```

### Required parameters

| Param | Type | Example | Notes |
|---|---|---|---|
| `location` | string | `LGW` | 3-letter IATA code of the **parking/departure** airport |
| `date` | string | `2026-04-18` | Drop-off date in `YYYY-MM-DD` format |

### Optional parameters

| Param | Type | Example | Notes |
|---|---|---|---|
| `query` | string | `BA` | Free-text filter (airline name, code, destination) |

### Example request

```bash
curl "http://localhost:8080/api/flights?location=LGW&date=2026-04-18"
```

With a filter:

```bash
curl "http://localhost:8080/api/flights?location=LGW&date=2026-04-18&query=Ryanair"
```

### Response

Raw JSON array from the Holiday Extras dock-yard API. Each element contains flight metadata including airline, destination, departure/arrival times, and terminal.

---

## Skill 2 — Search for Return Flights

**Goal:** Given the holiday destination airport, the return date, and the parking airport, return a list of flights arriving back at the parking airport on that date.

**Key difference from outbound:** The `location` param is the **origin of the return leg** (where the holiday was), and `destination` is the **parking airport** the traveller is returning to.

### Endpoint

```
GET /api/flights
```

### Required parameters

| Param | Type | Example | Notes |
|---|---|---|---|
| `location` | string | `ALC` | 3-letter IATA code of the holiday/origin airport |
| `date` | string | `2026-04-25` | Return date in `YYYY-MM-DD` format |
| `destination` | string | `LGW` | 3-letter IATA code of the **parking airport** (return destination) |

### Optional parameters

| Param | Type | Example | Notes |
|---|---|---|---|
| `query` | string | `easyJet` | Free-text filter |

### Example request

```bash
curl "http://localhost:8080/api/flights?location=ALC&date=2026-04-25&destination=LGW"
```

### Response

Same raw JSON format as the outbound response.

---

## Skill 3 — Submit a Parking Search

**Goal:** Given a complete set of parking and flight details, get a Holiday Extras redirect URL that lands the user on the checkout page with all fields pre-filled.

### Endpoint

```
POST /api/parking/search
Content-Type: application/json
```

### Request body schema

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

### Field reference

| Field | Required | Format | Description |
|---|---|---|---|
| `parkingAirport` | **Yes** | 3-letter IATA | Airport where the car is parked |
| `parkingDropoffDate` | **Yes** | `YYYY-MM-DD` | Date the car is dropped off |
| `parkingDropoffTime` | **Yes** | `HH:MM` (24h) | Time the car is dropped off |
| `parkingReturnDate` | **Yes** | `YYYY-MM-DD` | Date the car is collected |
| `parkingReturnTime` | **Yes** | `HH:MM` (24h) | Time the car is collected |
| `outboundFlight` | No | object | Selected outbound flight (omit if user skipped) |
| `outboundFlight.code` | No | string | IATA flight code, e.g. `BA1234` |
| `outboundFlight.departureTerminal` | No | string | Terminal letter/number, e.g. `N`, `S`, `2` |
| `outboundFlight.arrivalAirport` | No | string | Destination airport IATA code |
| `returnFlight` | No | object | Selected return flight (omit if user skipped) |
| `returnFlight.code` | No | string | IATA flight code |
| `returnFlight.arrivalTerminal` | No | string | Terminal at the parking airport on return |
| `returnFlight.departureAirport` | No | string | Origin airport IATA code for the return leg |

### Example request

```bash
curl -X POST http://localhost:8080/api/parking/search \
  -H "Content-Type: application/json" \
  -d '{
    "parkingAirport":    "LGW",
    "parkingDropoffDate": "2026-04-18",
    "parkingDropoffTime": "08:00",
    "parkingReturnDate":  "2026-04-25",
    "parkingReturnTime":  "16:00",
    "outboundFlight": {
      "code":              "BA1234",
      "departureTerminal": "N",
      "arrivalAirport":    "MAD"
    },
    "returnFlight": {
      "code":             "IB3167",
      "arrivalTerminal":  "N",
      "departureAirport": "MAD"
    }
  }'
```

### Response

```json
{
  "redirectUrl": "https://www.holidayextras.com/static/?selectProduct=cp&reloadKey=d1b72610#/categories?agent=WEB1&depart=LGW&out=2026-04-18&park_from=08%3A00&in=2026-04-25&park_to=16%3A00&flight=BA1234&terminal=N&redirectReferal=carpark&from_categories=true"
}
```

Open `redirectUrl` in a browser to land on the Holiday Extras parking results page with all parameters pre-filled.

### Error responses

| Status | Body | Fix |
|---|---|---|
| `400` | `{ "error": "missing required parking fields" }` | Check all five required fields are present |

---

## Skill 4 — Retrieve Recent Searches (Debug / Monitoring)

**Goal:** See the last 200 parking searches that have been submitted (no PII — airport codes, dates, and flight codes only).

### Endpoint

```
GET /api/log
```

### Example request

```bash
curl http://localhost:8080/api/log
```

### Response

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

## End-to-End Booking Flow

An AI assistant can guide a complete booking by chaining these skills:

```
1. Ask user for: parking airport, drop-off date, return date
   (times default to 08:00 drop-off, 16:00 return if not specified)

2. SKILL 1: GET /api/flights?location={airport}&date={dropoffDate}
   → Present flight list, ask user to pick or skip

3. SKILL 2: GET /api/flights?location={destAirport}&date={returnDate}&destination={airport}
   → Present return flight list, ask user to pick or skip

4. SKILL 3: POST /api/parking/search
   → Build payload from all collected values
   → Return redirectUrl to user

5. Direct user to open the redirectUrl to complete their booking on Holiday Extras
```

### Notes

- **Times** are expressed in 24-hour `HH:MM` format. If the user gives times like "8am", convert to `08:00`.
- **Flights are optional.** If the user doesn't have a flight or doesn't want to provide one, omit `outboundFlight` / `returnFlight` from the POST body entirely.
- **Terminal defaults** — if you don't know the terminal, omit `departureTerminal` / `arrivalTerminal` from the flight object. The HX site will still load correctly.
- **Flight cache** — flight data is cached server-side for 4 hours. If the data looks stale (e.g. no flights on a busy route), restarting the server clears the cache.
- **IATA codes** — always uppercase, exactly 3 letters. Common UK airports: `LGW` (Gatwick), `LHR` (Heathrow), `MAN` (Manchester), `EDI` (Edinburgh), `BHX` (Birmingham), `BRS` (Bristol), `STN` (Stansted), `LTN` (Luton).
