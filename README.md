# PawPal API

Node.js + Express backend shared by the **PawPal** customer app and the **Pawsome Partner** walker app:
phone sign-in, walker profiles, bookings, nearest-walker dispatch, live walk updates, push notifications and maps.

- **Firebase**: Firestore (data), Cloud Messaging (push), Phone Number Verification and Auth SMS (sign-in), all through the Admin SDK
- **OpenStreetMap** (free): Nominatim addresses, Photon search, OSRM walking routes, cached and rate-limited by the server
- **Open-Meteo**: current weather for the home screen (free for non-commercial use only; see Weather)
- TypeScript run directly by Node (no build step); `tsc` only type-checks

## Run it

```bash
npm install
cp .env.example .env      # optional: works with nothing set
npm run dev               # http://localhost:4000, restarts on file changes
npm test                  # end-to-end API tests (in-memory, no network)
npm run typecheck
```

With no Firebase credentials the server keeps its data in **`.data/dev-store.json`** (written after every
change and read back at startup), prints push notifications to the console, and only accepts development
logins (`dev:+91…`). Without `SESSION_SECRET` it signs sessions with a key it saves in `.data/dev-session-secret`,
so accounts **and the apps' saved sessions survive restarts**: you stay signed in when the app is closed or the
server restarts on a file change. Delete `.data/` to start from scratch, or set `STORE=memory` for throwaway
data. Add a service-account key to switch to Firestore + FCM + real phone verification.

**Development sign-in codes.** No SMS is sent in development: when an app taps "Send code", the server makes a
6-digit code and prints it here (`📨 Verification code 482913 for +91••••••3210`); type that code in the app.
Codes last 10 minutes, a new request replaces the old code, and 5 wrong tries mean sending a new one.

### USB phones and emulators

A development build on a USB phone or an emulator loads its JavaScript from Metro over `adb reverse` and calls this
API at `localhost:4000` **on the device**, which only works while adb forwards that port to your computer. adb drops
the forward whenever the phone is replugged or adb restarts, and sign-in then fails with a connection error. So in
development the server keeps it in place: every 10 s it lists the connected devices and adds
`adb reverse tcp:4000 tcp:4000` (your `PORT`) where it's missing, printing `Phone can reach the API over USB` once
per device. It never starts or restarts adb's own server, and leaves the port alone if something else already
forwards it elsewhere. adb is looked up in `ADB_PATH`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT`, then the SDK's
default folder, then `PATH`. Turn it off with `ADB_REVERSE=false`; it never runs in production. Metro's own forward
(`tcp:8081`) is still Expo's job: after an adb restart, run `adb reverse tcp:8081 tcp:8081` or reopen the app from
Expo. On Wi-Fi instead of USB, the phone needs your computer's address in `EXPO_PUBLIC_API_URL` and the port open in
the firewall.

### Logs

`npm run dev` prints a startup box with the configuration, then one coloured line per request and per event:

```
02:01:48.516 ● booking  Booking created  booking=6c107efd… tier=express dog="Bruno (Beagle)" price=₹299 status=searching
02:01:48.518 ● dispatch Offered to walker  booking=6c107efd… walker=da471ffd… km=0.2 payout=₹254.15 expires=25s try=1/5
02:01:48.518 ● push     New walk request • ₹254.15  to=partner user=da471ffd… type=offer urgent=true
02:01:48.519 ✔ http     POST   /bookings                          201   18 ms  customer·8fab76fa…
                        ↳ body  { tier: "express", dog: { name: "Bruno", … }, pickup: { … } }
02:01:48.530 ▲ http     POST   /bookings/6c107efd…/start          400  2.7 ms  partner·da471ffd…  wrong_otp: Wrong OTP. 4 tries left.
```

`✔` 2xx, `▲` 4xx or a warning, `✖` 5xx or an error. Repeated polls (the apps re-read every few seconds)
collapse into one line with a `×N` count. Ids are shortened, secrets (tokens, OTPs, typed sign-in codes,
signatures, keys) are always hidden and phone numbers, emails and UPI IDs masked; the one code ever printed is a
development sign-in code, on its own `📨` line. `LOG_LEVEL`, `LOG_FORMAT` and
`LOG_BODIES` (see `.env.example`) change the detail; production defaults to one JSON object per line
at `info`, without bodies, for the hosting provider's log viewer.

## Deploy

`docker build -t pawpal-api .` produces a Node 22 image (native TensorFlow for face matching) that serves on
`$PORT` (4000) with a `/health` check. Production refuses to start without `SESSION_SECRET`, Firebase credentials
(Firestore + FCM), YouPI settings, and, when verification is on, `ID_HASH_PEPPER` and `BGV_WEBHOOK_SECRET`. The
dispatch timers run inside the process, so run **one instance**. CI (`.github/workflows/ci.yml`) type-checks and
runs the tests; this folder isn't a git repository yet (`git init` to use it).

## Connect Firebase

1. **Service account**: Firebase console → Project settings → Service accounts → *Generate new private key*.
   Save it as `secrets/firebase-admin.json` (git-ignored) and set `FIREBASE_SERVICE_ACCOUNT=secrets/firebase-admin.json`.
2. **Firestore**: Build → Firestore Database → *Create database* (region `asia-south1`, Mumbai). Only this server
   touches Firestore, through the Admin SDK, so leave the security rules denying all client access.
3. **Push (FCM)**: nothing to enable on the server. The apps get their FCM token with
   `expo-notifications` → `getDevicePushTokenAsync()` and send it to `POST /devices`. Android builds need the
   project's `google-services.json`; iOS needs an APNs key uploaded under Cloud Messaging.
4. **Phone sign-in**: two methods, because Firebase Phone Number Verification doesn't cover India yet.
   - **`pnv` (carrier check, no SMS)**: Android only, and only on the carriers Firebase lists (12 countries in
     Oct 2026: UK, Germany, Spain, Indonesia and others; **no Indian carriers**). Needs the Blaze plan, OAuth
     brand verification and the app's SHA-256 fingerprint. App side: `@react-native-firebase/phone-number-verification`
     in a development build (not Expo Go). The **test token** from *Phone Verification → Testing* belongs in the
     Android app (`enableTestSession(token)`, before any other call), not on this server. It lasts 7 days, and test
     sessions return the country code followed by zeros.
   - **`sms` (OTP, works in India)**: enable Authentication → Sign-in method → *Phone*. The app signs in with
     `@react-native-firebase/auth` (`signInWithPhoneNumber`), then sends `await user.getIdToken()` with
     `method: "sms"`. Firebase bills SMS per message; check its current pricing.
   - Apps should ask PNV first (`getVerificationSupportInfo()`), and fall back to SMS when it's unsupported.

## Maps

All free OpenStreetMap services; the apps keep using OpenFreeMap tiles for the map itself. The public servers are run
by volunteers with usage policies: Nominatim allows **one request per second** and no search-as-you-type (so search
goes to Photon), and every server wants the app identified (`MAPS_USER_AGENT` with a contact address). The API
spaces Nominatim calls, caches every answer for a day, and only serves signed-in users, which is fine for
development and a small launch. Before real traffic, run your own copies (Nominatim, Photon and OSRM all have
Docker images; use the India extract from Geofabrik) and set `NOMINATIM_URL`, `PHOTON_URL` and `OSRM_FOOT_URL`.
Show "© OpenStreetMap contributors" on map screens (OpenFreeMap's style already does).

## Weather

`GET /weather` asks Open-Meteo's forecast API (`WEATHER_URL`, default `https://api.open-meteo.com/v1/forecast`,
no key) for the current temperature and WMO weather code, and caches each reading for 15 minutes per ~1 km cell
(lat/lng rounded to 2 decimals), so calls grow with the areas in use (at most 96 a day per cell), not with app
installs. If it's
down, slow or answers nonsense the API returns `503 weather_unavailable` (and doesn't ask again for that cell for
a minute); the app then hides the weather pill. `WEATHER_ENABLED=false` turns it off. **Licence:** Open-Meteo's
free API is for non-commercial use only. Before launch, either buy its API plan and set `WEATHER_URL` to the
customer URL with your key (`https://customer-api.open-meteo.com/v1/forecast?apikey=…`; the key stays out of the
logs), or put another provider behind the same response. Production logs a warning while the free URL is set.

## API

All bodies are JSON. Authenticated routes need `Authorization: Bearer <sessionToken>`.
Errors look like `{ "error": { "code": "wrong_otp", "message": "Wrong OTP. 4 tries left." } }`.

### Sign-in

| | |
|---|---|
| `POST /auth/phone/code` `{ phone, app: "customer"\|"partner", method: "dev"\|"firebase" }` | Step one, no session needed; `phone` is E.164. `dev` (development servers only, else `403 dev_login_off`): the server makes a 6-digit code, keeps it 10 minutes (a new request replaces it), prints it in its console and answers `{ method: "dev", expiresAt, devCode }`; no SMS is sent. `firebase`: the app has already sent the SMS through Firebase; the server only logs it and answers `{ method: "firebase" }` (no code passes through the server). At most 5 requests per number and 20 per client IP in 10 minutes, then `429 too_many_codes`. |
| `POST /auth/phone` `{ token, method: "pnv"\|"sms", app: "customer"\|"partner", name?, code? }` | Exchanges proof of a phone number for `{ sessionToken, user, partner }`. `pnv`: a Firebase Phone Number Verification token (each works once). `sms`: the Firebase Auth ID token after an SMS-OTP sign-in. In development, `dev:+919876543210` works for either; if a `dev` code was requested for that number and hasn't expired, `code` (6 digits) must match it: without it `401 code_required`, wrong `401 wrong_code` ("… 4 tries left."), and after 5 wrong tries `401 code_locked` until a new code is sent. A right code works once. With no code requested, a `dev:` token signs in as before. `code` is ignored for Firebase tokens. One account per number; the same person can use both apps. |
| `GET /me` · `PATCH /me { name }` | The signed-in user. |
| `POST /devices { token, platform }` | Registers this install's FCM token for push. |
| `DELETE /devices/:token` | On sign-out. |

### Pet parent (customer app)

The home screen's endpoints are specified in [docs/DASHBOARD_API.md](docs/DASHBOARD_API.md) (the contract the
app codes against); in short:

| | |
|---|---|
| `GET /pricing?at=` | **Public.** Express prices for 30 / 45 / 60 minutes at that moment (default now), whether it's peak, the pack and trial prices, and the pack's batch slots. |
| `GET /walkers/nearby?lat=&lng=&temperament=` | `{ count, eligible, nearestKm, arrival: { minMinutes, maxMinutes } \| null }`: online walkers around a place, how many could take this dog, and when one could arrive. Never who or where. |
| `GET /weather?lat=&lng=` | `{ tempC, condition, icon, updatedAt }`, or `503 weather_unavailable` (see Weather). |
| `POST /bookings { tier, minutes?, scheduledFor?, dog: { name, breed, size, temperament?, notes? }, pickup: { lat, lng, address }, society? }` | Books a walk. The server prices it (₹120 subscription walk, ₹99 trial; express ₹299 / ₹379 / ₹449 for `minutes` 30 / 45 / 60, ₹50 more at 7–9 AM and 5–7 PM IST) and starts finding a walker. Other tiers take no `minutes` but their own (`400 minutes_not_allowed`). The response includes the 4-digit `pickupOtp`. |
| `GET /bookings` · `GET /bookings/:id` | Own walks, with the walker (`{ id, name, initials, rating, verified }`, never their phone), live `walkerLocation`, the walked `track` (`[lng, lat, at]`) and, once completed, `distanceKm`. |
| `POST /bookings/:id/payment` → `{ checkoutUrl }` | Opens (or reuses) the YouPI checkout for an `awaiting_payment` booking. Open it in the in-app browser. |
| `GET /bookings/:id/payment` | After returning from checkout: the server asks YouPI and updates the booking. |
| `POST /bookings/:id/cancel` | Before the walk starts. A paid, cancelled walk is flagged `payment.refundDue` (UPI refunds are manual). |
| `POST /bookings/:id/retry` | After `unmatched` (nobody was free). |
| `POST /bookings/:id/rating { rating: 1–5 }` | Once, after the walk. Added to the walker's average (`ratingSum` / `ratingCount` on the partner). |
| `GET /subscriptions` | Monthly packs, newest first, with progress (`walksDone`, `walksLeft`), `slotLabel`, `skipDates`, `nextWalk` (with the pickup OTP until it starts), the pack's `walker` (rating, verified, last 4 of the gate pass) and `backup`. Paying for a `subscription` walk (₹3,120) buys 26 walks; the server books one a day at that time, 12 h ahead. |
| `POST /subscriptions/:id/skip { date? }` | Skips a day (default the next walk's): a booked walk is cancelled and credited back, a later day is passed over by the generator. `409 cannot_skip` for a past day, a started walk or a cancelled pack. |
| `PATCH /subscriptions/:id { slotMinute }` | Moves the daily time to a batch slot (6:00–9:00 AM or 5:00–8:00 PM starts, every 30 min, matching the apps' 6:00–9:30 AM and 5:00–8:30 PM batches; else `400 invalid_slot`). Walks without a walker yet move; assigned ones keep their time. |
| `POST /subscriptions/:id/cancel` | Stops the pack; returns its view. |
| `DELETE /me` | Deletes the account (both apps). Refused during a walk. |

### Walker (partner app)

| | |
|---|---|
| `GET /partners/me` · `PATCH /partners/me` | Profile: `name, area, roles, sizes, skills, availability, walkRate, hourlyRate, radiusKm` (rates in ₹). `GET` also has `ratingSum` / `ratingCount` once walks are rated. |
| `POST /partners/me/application` | Submit for approval (auto-approved while `AUTO_APPROVE_PARTNERS=true`). |
| `PUT /partners/me/status { online, lat, lng }` | The online toggle. Send it again every few minutes while online so dispatch knows where the walker is. |
| `GET /partners/me/offers` | Requests waiting for an answer (also pushed). The flat number is hidden until accepted. |
| `GET /partners/me/earnings?days=7` | Completed walks' payouts per India-time day, and all-time totals. |
| `POST /offers/:id/accept` · `POST /offers/:id/decline` | |
| `POST /bookings/:id/start { otp }` | The pet parent's pickup OTP; 5 wrong tries lock the walk. |
| `POST /bookings/:id/location { lat, lng }` | Live position (on the way and during the walk). |
| `POST /bookings/:id/events { type: pee\|poop\|photo\|note, lat?, lng?, note? }` | Logged on the walk and pushed to the pet parent. |
| `POST /bookings/:id/complete` | |

### Maps (either app)

| | |
|---|---|
| `GET /maps/reverse-geocode?lat=&lng=` | Address for a point (Nominatim). |
| `GET /maps/geocode?address=` | Points for an address (Nominatim). |
| `GET /maps/autocomplete?input=&lat=&lng=` | Search-as-you-type near a location (Photon), India only by default. |
| `GET /maps/route?from=lat,lng&to=lat,lng` | Walking route: `distanceMeters`, `durationSeconds`, `coordinates` as `[lng, lat]` pairs. |

## Partner verification (4 gates)

On when `DATABASE_URL` is set (Postgres 16 + pgvector; `docker compose up -d` also starts Ollama and pulls
`qwen2.5vl:7b`). Partner-app session required; every response carries `nextGate`
(`gate1 → gate2 → gate3 → awaiting_background_check | cleared`, or `rejected`).

**Without Docker (development):** `DATABASE_URL=pglite://.data/pglite` runs Postgres + pgvector inside the API
process (PGlite, saved in that folder). Install [Ollama](https://ollama.com/download) natively and run
`ollama pull qwen2.5vl:7b`. Not for production: the server refuses `pglite://` when `NODE_ENV=production`.

| `/api/v1/partner-verification/…` | |
|---|---|
| `GET status` | Where the partner is in the pipeline. |
| `GET gate1-safety-quiz` · `POST gate1-safety-quiz { answers: { questionId: optionId } }` | 5 dog-handling scenarios; 4/5 passes. Wrong answers come back with the explanation. |
| `POST gate2-verify-id-and-selfie` (multipart: `idDocumentImage`, `liveSelfieImage`, `countryCode`, `biometricConsent=true`) | See below. `{ verified, badge, similarityScore, reasons[], extracted: { fullName, dob, idType, idNumberMasked }, attemptsLeft }`. 5 attempts. |
| `POST gate3-background-check { societyGatePassNumber?, consentGiven }` | Queues the court-record check. A society gate pass gives `PROVISIONAL_SOCIETY_PASS` (trust tier 1: friendly dogs) meanwhile. |
| `POST gate4-shift-selfie-unlock` (multipart: `shiftSelfieImage`, `bookingId`, `gpsLat`, `gpsLng`) | At the pickup door: within 100 m, live, and a match with the enrolled face. Returns `handshakeToken`, which `POST /bookings/:id/start` then requires with the OTP, and switches on the ₹10,000 walk insurance. |
| `DELETE me/biometrics` | Right to erasure: drops the face template and ID hash. |
| `POST webhooks/background-check { jobId, outcome: clear\|rejected\|failed, reference?, details? }` | Signed: `X-PawPal-Timestamp: <ms>` and `X-PawPal-Signature: sha256=HMAC(BGV_WEBHOOK_SECRET, "<timestamp>.<raw body>")`, ±5 min. `clear` → `VERIFIED`, tier 2. |

**Gate 2, step by step:** sharp decodes each upload once (size limits, EXIF rotation, ≤1280 px, metadata stripped,
editing-software EXIF flagged). Then, in parallel: **Qwen2.5-VL** (any OpenAI-compatible endpoint) reads the ID and
checks both photos for screens, prints and tampering, returning JSON validated by zod with one corrective retry; and
**@vladmandic/human** finds the faces, checks the selfie's pose, open eyes, anti-spoof and liveness scores, and
extracts 1024-d descriptors. The ID-to-selfie **cosine similarity** must reach 0.82. The ID number is HMAC'd with
`ID_HASH_PEPPER` (a masked Aadhaar uses last-4 + name + DOB) and must not belong to another account, and a pgvector
HNSW search rejects any other account whose face is ≥ 0.88 similar, including rejected ones. Only a passed check
stores the selfie descriptor and the hash; the ID image is never written anywhere and its buffers are overwritten.
Failures return reason codes (`id_not_physical`, `selfie_eyes_closed`, `face_mismatch`, `duplicate_identity`, …) that
the app turns into retake instructions.

**Before launch:**
- **Calibrate the thresholds.** 0.82 / 0.85 / 0.88 are starting points. Human's `faceres` descriptor isn't ArcFace,
  and printed ID portraits are small and old. Run a few dozen consenting real pairs, look at `vlm_audit_json`
  (it records every similarity, pose and liveness score), and set `FACE_MATCH_*`.
- **Background-check vendors.** Jobs are queued per partner with provider `manual`: ops runs the check and posts the
  signed result. IDfy / AuthBridge (India) and Checkr adapters need their API contracts. The society gate-pass
  number is stored as given (MyGate and NoBrokerHood have no public verification API).
- **Aadhaar.** UIDAI rules restrict collecting and storing Aadhaar numbers. Ask for the masked Aadhaar or another ID,
  or use DigiLocker, and get legal sign-off on biometric consent and retention under the DPDP Act.
- Face models run on native TensorFlow when `@tensorflow/tfjs-node` installs (Linux, Node 20/22); elsewhere they fall
  back to WASM (slower, same results).

## Payments (YouPI)

With `YOUPI_URL`, `YOUPI_MERCHANT_ID` and `YOUPI_MERCHANT_KEY` set (required in production), a new booking is
`awaiting_payment` and walkers are only looked for once it's paid. The server prices it, creates the YouPI session
(one order id per attempt, also the idempotency key) and decides "paid" itself, from the signed webhook
(`POST /webhooks/youpi`, HMAC of the raw body with the merchant key) or the merchant view of the payment. The amount
must match to the paisa and YouPI must have matched the payment to a bank alert (`PAYMENT_MIN_VERIFICATION_LEVEL`,
default 1); otherwise it's held as `review`. Unpaid bookings are released after `PAYMENT_HOLD_MINUTES`. Money that
arrives after a release, or for a cancelled walk, sets `payment.refundDue`: refund those by hand, since UPI collections
have no refund API. There is no ops screen yet for `review` and `refundDue` bookings; query them in Firestore.

## How dispatch works

A new booking is offered to the **closest online, approved walker** whose service radius covers the pickup,
whose location is under 15 minutes old, and whose trust tier allows the dog (`friendly` needs tier 1;
`pulls` / `reactive` need tier 2). They get a high-priority push and 25 seconds to accept; on a
decline, a timeout or going offline it moves to the next closest, up to 5 walkers, then the booking is
`unmatched` and the pet parent is told. Accepting is a transaction, so two walkers can never both get one walk.

A monthly pack's walks go to its **primary walker** first (the first walker who accepted one of its walks), then
its **backup** (the closest other walker cleared for the dog, by last reported position), then the nearest as
above, always among the walkers who pass the checks above at that moment.

Booking statuses: `searching → assigned → active → completed`, or `cancelled` / `unmatched`.

## Not built yet

- **Walker payouts**: earnings are reported (`/partners/me/earnings`), but nothing transfers money to walkers yet.
- **Ops tools** for payments held for review, refunds due and background-check results.
- **Background-check vendor adapters** (see Partner verification). Without `DATABASE_URL`, applications are approved
  without any checks (`AUTO_APPROVE_PARTNERS`).
- **Geo indexing**: dispatch scans online walkers, fine for one city's worth of walkers, not for tens of thousands.
- The dispatch timer runs inside the server process, so run **one instance** (or move it to a scheduled job).
#   P a w P a l - B a c k e n d  
 