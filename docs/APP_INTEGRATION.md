# App ↔ API integration contract

Binding rules for the PawPal (customer) and Pawsome Partner (walker) apps talking to this API. Endpoint details
are in the README; this file fixes the cross-cutting decisions so both apps behave the same.

## 1. Base URL and sessions

- Base URL: `EXPO_PUBLIC_API_URL`. Required in preview/production builds (fail loudly at startup if missing).
  Development fallback only: web → `http://localhost:4000`; device → the Metro host from
  `Constants.expoConfig.hostUri` on port 4000.
- `POST /auth/phone` returns `{ sessionToken, user, partner }`. Persist `sessionToken` with **expo-secure-store**
  (never AsyncStorage). Send `Authorization: Bearer <token>` on every call.
- On any `401` with code `session_required`, clear the stored session and route to sign-in.
- Sessions are per app (`app: "customer"` or `"partner"`); the same phone number can use both apps.

## 2. Phone sign-in

One module per app with `requestCode(phone)` and `confirmCode(code)`:

- **Release builds (production/preview)**: Firebase Auth SMS via `@react-native-firebase/auth`
  (`signInWithPhoneNumber` → `confirm(code)` → `getIdToken()`), then `POST /auth/phone { token, method: "sms", app, name? }`.
  Firebase is only in builds made with `GOOGLE_SERVICES_JSON` (Android) / `GOOGLE_SERVICE_INFO_PLIST` (iOS); the
  native module is loaded through a guard, so a build without it shows "Sign-in isn't configured" instead of crashing.
  Once `signInWithPhoneNumber` resolves, fire `POST /auth/phone/code { phone, app, method: "firebase" }` without
  waiting for it: it only puts "Verification SMS sent by Firebase" in the API console. Its failures are logged in
  development, never shown, and never block sign-in. The SMS code itself never goes to the server.
- **Development builds (`__DEV__`) without Firebase**: a real round trip with a code the server makes, through the
  server's development login (on only when `AUTH_DEV_LOGIN` is, never in production):
  1. `requestCode(phone)` calls `POST /auth/phone/code { phone, app, method: "dev" }` **before** moving to the code
     step, so an unreachable API fails at "Send code" rather than after the code is typed. The reply is
     `{ method: "dev", expiresAt, devCode }`; the server prints the same code in its console. Log
     `📨 Verification code <devCode> sent to <masked phone> (development: also in the API console)` with
     `devLog('auth')`, and **don't** fill the code in for the user.
  2. `confirmCode(code)` sends `POST /auth/phone { token: "dev:<E.164>", app, name?, code }`.
  3. Show the server's `message` as it comes for `code_required`, `wrong_code` ("… N tries left."), `code_locked`
     (5 wrong tries; send a new code), `too_many_codes` (429: 5 per number, 20 per client IP, per 10 minutes) and
     `dev_login_off` (403).
  - The development hint on the sign-in screens reads: "Development build: no SMS is sent. The code is printed in
    the API console (and Metro)."
  - A `dev:` token for a number that has no pending code (expired, or never requested: scripts, old builds) still
    signs in without a code.
- **USB phones and emulators** reach the API at `localhost:4000` on the device through `adb reverse`; in
  development the API keeps that forward in place itself (README, "USB phones and emulators").
- Firebase Phone Number Verification (carrier, no SMS) doesn't cover Indian carriers; don't build it in yet.
- Phone numbers are sent as E.164. A bare 10-digit number is Indian (`+91`).

## 3. Data freshness

- Use **@tanstack/react-query** for server state (one `QueryClient` per app, `focusManager` wired to `AppState`,
  `onlineManager` to `expo-network` or NetInfo if already present). No server data in React context.
- Polling while the screen is focused and the app is in the foreground:
  - walker offers `GET /partners/me/offers`: every 4 s while online;
  - a live booking `GET /bookings/:id`: every 5 s while `assigned` or `active`, 10 s while `searching` / `awaiting_payment`;
  - lists: on focus, pull-to-refresh, and after mutations (invalidate).
- Push notifications are the wake-up signal in the background; polling is the source of truth in the foreground.

## 4. Walker location (Partner app)

- `expo-location`, foreground permission only (background tracking is a later phase; say so in the UI copy).
- While online: `PUT /partners/me/status { online: true, lat, lng }` on going online and every 60 s.
  Going offline: `{ online: false }`.
- During an `assigned` or `active` walk: `POST /bookings/:id/location` every 5 s (the server thins the route).
- Keep the screen awake during an active walk (`expo-keep-awake`).

## 5. Push

- `expo-notifications`: request permission after sign-in, get the **device** (FCM/APNs) token with
  `getDevicePushTokenAsync()`, `POST /devices { token, platform }`. On sign-out `DELETE /devices/:token`.
- FCM needs `google-services.json` in the build (same `GOOGLE_SERVICES_JSON` switch as sign-in). Without it, skip
  registration silently in development.
- Notification `data.type`: `offer` (→ requests), `booking` (→ that booking's live screen), `walk_event`,
  `verification`. Route on tap.

## 6. Payments (PawPal)

- New bookings come back `awaiting_payment` when the server has payments on (`payment.status: "unpaid"`).
- `POST /bookings/:id/payment` → `{ checkoutUrl }`; open it with `expo-web-browser`
  `openAuthSessionAsync(checkoutUrl, "pawpal://payment-return")`. Afterwards (and while the sheet waits),
  `GET /bookings/:id/payment` until `payment.status` is `paid`, `failed` or `review`.
- `paid` → booking moves to `searching`. `review` → "We're confirming your payment" (no retry button).
  `failed` → offer "Try again" (calls `POST …/payment` again; the server opens a new attempt).
- The app never computes prices: show `booking.price` / `payment.amount` from the server. Show tier prices on
  the plan and home screens from `GET /pricing` (public; ₹120 per subscription walk, ₹3,120 per 26-walk pack,
  ₹99 trial, express ₹299 / ₹379 / ₹449 for 30 / 45 / 60 minutes, ₹50 more at 7–9 AM and 5–7 PM IST, so ₹349 /
  ₹429 / ₹499), labelled as the price shown before checkout. Book an express walk's length with
  `POST /bookings { tier: "express", minutes: 30 | 45 | 60 }`. The home screen's other data (walkers nearby,
  weather, the pack card) is specified in [DASHBOARD_API.md](DASHBOARD_API.md).
- If payments are off on the server (`payment.status: "not_required"`), skip checkout.
- Remove the direct-UPI (UTR) path and any hard-coded UPI ID.

## 7. Money and copy

- All money is **INR**. Format with Indian grouping (`₹1,00,000`, paise only when non-zero). The Partner app's
  former USD figures become INR. `walkRate` is "the smallest payout per walk you'll accept" (default ₹80);
  `hourlyRate` is the sitting rate shown to pet parents.
- Weekly walker payouts go to `partner.payoutVpa` (a UPI ID). There is no instant cashout and no bank-account
  storage: remove those demo features rather than fake them.

## 8. Errors

- Every error body is `{ error: { code, message } }`. Show `message` (it is user-facing copy); branch on `code`.
- Network failure / timeout: a retryable inline error state, never a blank screen or infinite spinner.
- Default request timeout 30 s; the ID check (`gate2`) 200 s.

## 9. Demo code

- Simulations (scripted walks, fake timers, canned chat, seeded people and stats, "Simulate…" buttons, fake
  OTPs, constant pickup OTPs) are removed from the app. Where a feature has no backend yet (chat, masked calls,
  SOS vet), hide it or show an honest "coming soon" instead of a fake success.
- Fixed data that is product content (society list, plan descriptions, quiz) can stay in the app.
