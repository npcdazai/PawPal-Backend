# Home dashboard API (contract)

The customer home screen (PawPal) shows a monthly society pack card, an instant/express walk card, the
latest walk's proof strip and a header. Everything on it comes from these endpoints; the app never
computes a price, a count or a walker. All money is INR (rupees). "IST" means India time.

All routes below need a **customer** session (`Authorization: Bearer …`) unless marked *public*: no
session → 401 `session_required`, a partner session → 403 `forbidden`. Errors use the usual
`{ error: { code, message } }` shape with user-facing `message`; a malformed query or body is 400
`invalid_input`.

## 1. Express walk lengths and prices

Express walks come in **30, 45 and 60 minutes**. Base fares: 30 → ₹299, 45 → ₹379, 60 → ₹449. The
peak-hour surcharge stays: **+₹50** 7–9 AM and 5–7 PM IST (so ₹349 / ₹429 / ₹499), judged at the walk's
start (`scheduledFor`, default now); 9:00 AM and 7:00 PM are already off-peak. The walker's payout stays
85% of the price (2 decimals). Subscription (₹120, 30 min) and trial (₹99, 15 min) are unchanged and
never have a surcharge.

- `POST /bookings` accepts `minutes?: 30 | 45 | 60` for `tier: 'express'` (default 30). For other tiers
  `minutes` must be absent or equal to the tier's length (trial 15, subscription 30). Anything else
  (including 20 or 30.5) is 400 `minutes_not_allowed`. The booking's `minutes`, `price`, `payout` and
  `payment.amount` follow from it.
- `GET /pricing?at=<epoch ms>` — *public*. Prices at `at` (default now):
  ```json
  {
    "currency": "INR",
    "peak": false,
    "peakWindows": ["07:00–09:00", "17:00–19:00"],
    "express": [{ "minutes": 30, "price": 299 }, { "minutes": 45, "price": 379 }, { "minutes": 60, "price": 449 }],
    "subscription": {
      "perWalk": 120, "walks": 26, "total": 3120, "minutes": 30,
      "slots": [{ "slotMinute": 360, "label": "6:00 – 6:30 AM" }, …, { "slotMinute": 1170, "label": "7:30 – 8:00 PM" }]
    },
    "trial": { "price": 99, "minutes": 15 }
  }
  ```
  `subscription.slots` is the list of daily times a pack can move to (§4, `PATCH /subscriptions/:id`),
  so the app never hard-codes it.

## 2. Walkers near a place

`GET /walkers/nearby?lat=&lng=&temperament=friendly|pulls|reactive` (temperament optional):

```json
{ "count": 2, "eligible": 2, "nearestKm": 0.4, "arrival": { "minMinutes": 15, "maxMinutes": 30 } }
```

- `count`: online, approved walkers with a location fresher than the dispatch limit
  (`DISPATCH_LOCATION_MAX_AGE_MINUTES`, 15) whose radius covers the point (the same filter dispatch
  uses, without the payout check). The signed-in user never counts themselves.
- `eligible`: those whose trust tier clears `temperament` (friendly needs tier 1, pulls/reactive tier 2;
  all of `count` when it's omitted).
- `nearestKm`: straight-line distance to the nearest eligible walker, 1 decimal; `null` when nobody is
  eligible.
- `arrival`: walking time from the nearest eligible walker at 4.5 km/h plus a 10-minute buffer, rounded
  to 5 minutes, as a 15-minute window inside 10–120 minutes:
  `minMinutes = clamp(round5(km / 4.5 × 60 + 10), 10, 105)`, `maxMinutes = minMinutes + 15`;
  `null` when nobody is eligible.
- Never returns who the walkers are or where they stand.

## 3. Weather

`GET /weather?lat=&lng=` → `{ "tempC": 28, "condition": "clear", "icon": "☀️", "updatedAt": 1792876932443 }`

- `tempC`: whole degrees Celsius. `updatedAt`: when the server fetched the reading (epoch ms).
- `condition` and `icon`: `clear` ☀️ (🌙 at night), `partly-cloudy` ⛅ (☁️ at night), `cloudy` ☁️,
  `fog` 🌫️, `drizzle` 🌦️, `rain` 🌧️, `thunderstorm` ⛈️, `snow` ❄️ (from the WMO weather code; an
  unknown code reads as `cloudy`).
- Provider: Open-Meteo by default (`WEATHER_URL`, no key), cached 15 minutes per ~1 km cell (lat/lng
  rounded to 2 decimals); simultaneous requests for one cell share one upstream call.
  `WEATHER_ENABLED=false` turns it off. Upstream down, slow (5 s), malformed, or disabled → 503
  `weather_unavailable` (the app hides the pill); after a failure the cell answers 503 for a minute
  without asking again. Open-Meteo's free API is for non-commercial use: production needs its paid plan
  (its customer URL with `?apikey=` in `WEATHER_URL`) or another provider behind the same response.

## 4. Monthly packs (subscriptions)

`GET /subscriptions` returns `{ subscriptions: SubscriptionView[] }`, newest first:

```json
{
  "id": "…", "customerId": "…", "status": "active",
  "dog": { "name": "Barnaby", "breed": "Corgi", "size": "medium", "temperament": "friendly", "notes": "" },
  "pickup": { "lat": 19.1, "lng": 72.9, "address": "…" },
  "society": { "societyId": "…", "tower": "A", "flat": "1402" },
  "walksTotal": 26, "walksBooked": 18, "walksDone": 17, "walksLeft": 8,
  "perWalk": 120,
  "slotMinute": 420, "slotLabel": "7:00 – 7:30 AM",
  "skipDates": ["2026-10-27"],
  "nextWalk": { "bookingId": "…", "scheduledFor": 1792900000000, "date": "2026-10-26", "status": "assigned", "pickupOtp": "7391" },
  "walker": { "id": "…", "name": "Rohan Deshmukh", "initials": "RD", "rating": { "average": 4.96, "count": 25 }, "verified": true, "gatePass": "4092" },
  "backup": { "id": "…", "name": "Pratik K.", "initials": "PK" },
  "lastScheduledFor": 1792813600000, "createdAt": 1792000000000, "updatedAt": 1792876932443
}
```

- `status`: `active` (the generator still books walks), `finished` (all 26 booked; a skipped or
  cancelled walk makes it `active` again) or `cancelled`.
- `walksLeft = walksTotal - walksBooked` (cancelled or skipped pack walks are credited back, as today, so
  the pack runs a day longer). `walksDone` counts the pack's completed walks.
- `slotLabel`: the 30-minute block the walk starts in ("7:00 – 7:30 AM", "11:45 AM – 12:15 PM").
- `skipDates`: upcoming IST days the pet parent skipped (booked walks cancelled by a skip, and days not
  booked yet), sorted; days before today drop off.
- `nextWalk`: the pack's earliest booking that isn't finished (`completed`/`cancelled`) and is either
  walking now (`active`) or not yet past its end time (`scheduledFor + minutes`), else, while the pack is
  `active`, the next date the generator will book (with `bookingId: null`, `status: "scheduled"`,
  `pickupOtp: null`), else `null`. A walk whose time has fully passed without starting doesn't block it.
  `pickupOtp` only while the walk isn't started (`null` once `active`). `status` is the booking's
  (`searching`, `assigned`, `unmatched`, `active`) or `scheduled`.
- `walker`: the pack's **primary walker** — set the first time a walker accepts one of its walks, and
  shown to the pet parent by name only (no phone, no location). `verified`: trust tier ≥ 1.
  `gatePass`: the last 4 characters of the walker's society gate pass when the verification pipeline
  has one, else `null`. `rating`: the walker's average over all rated walks (2 decimals) or `null`.
  If the primary stops qualifying (account deleted, no longer approved, or no longer cleared for the
  dog's temperament) they're cleared (`walker: null`) and the next walker to accept becomes primary.
- `backup`: a second approved walker who clears the dog's temperament and is closest to the pickup (by
  their last reported position, among walkers whose radius covers the pickup and who accept the pack's
  ₹102 payout; online or not), chosen when the primary is set and re-chosen if they stop qualifying
  (as above), become the primary, or there was nobody last time; `null` when there's nobody or no
  primary. Shown as first name and last initial. Both are kept current whenever the pack is read,
  offered or accepted.
- Dispatch prefers them: a pack walk is offered to the primary walker first (if online, fresh and
  eligible), then the backup, then the usual nearest walkers.

`POST /subscriptions/:id/skip` `{ date?: "YYYY-MM-DD" }` (IST date, default `nextWalk.date`):
skips that day's walk. If it's booked and not started (`searching`, `assigned`, `unmatched`), it's
cancelled and credited back to the pack (the walker is told, by push); if it isn't generated yet, the
date goes into `skipDates` and the generator passes it. Either way the day is in `skipDates`. Skipping
a day already skipped returns the view unchanged. Refused with 409 `cannot_skip` for a past date, a
started (or completed) walk, a cancelled pack, a day the generator has already passed without a walk,
a not-yet-booked day of a `finished` pack, or a date more than 31 days ahead. Someone else's pack → 404.
Returns `{ subscription: SubscriptionView }`.

`PATCH /subscriptions/:id` `{ slotMinute }`: changes the daily time. Allowed starts are the apps' batch
slots, a 30-minute walk every half hour in the morning batch (6:00–9:30 AM) and the evening batch
(5:00–8:30 PM): starts 360, 390, …, 540 (6:00–9:00 AM) and 1020, …, 1200 (5:00–8:00 PM), 14 in all,
listed by `GET /pricing` as `subscription.slots` (400
`invalid_slot` otherwise; 409 `pack_cancelled` for a cancelled pack). Applies from the next walk that
has no walker yet (its time moves): every booked walk still `searching` moves to the new time on its own
day if that time is still ahead, any open request for it is withdrawn, and walkers are looked for again
45 minutes before the new time. A walk already assigned keeps its time (so do `unmatched` walks and walks
whose new time has passed). Walks the generator books later use the new time. The same slot again is a
no-op. Returns `{ subscription: SubscriptionView }`.

`POST /subscriptions/:id/cancel` is unchanged (returns the view too).

## 5. Bookings: walker and distance

The customer's booking view (`GET /bookings`, `GET /bookings/:id`, and every booking returned to the
customer) gains:

- `walker: { id, name, initials, rating: { average, count } | null, verified } | null` once a walker is
  assigned (name only; never phone, area or location beyond the existing `walkerLocation` during a walk).
  This replaces the earlier `walker: { name, area }`.
- `distanceKm`: the walked distance from the recorded route (point to point), 2 decimals, once the walk
  is completed (stored at completion; `0` when no route was recorded); `null` before.

The walker's average rating is kept on the partner (`ratingSum`, `ratingCount`, also in the partner
app's `GET /partners/me`) and updated when a walk is rated. Walks rated before this was added aren't in
it.

## 6. Insurance (unchanged data, display rule)

A booking's `insurance` (`{ active, coverInr, activatedAt }`) is set only by the doorstep check. The app
shows a cover amount **only** from an active booking's `insurance.coverInr`; otherwise no amount.
