# Steward Admin (iOS & Android)

A native React Native app (Expo SDK 58, expo-router) for running your SaaS from a phone. It talks to the same admin API as the web panel. It is not a WebView wrapper.

## Features

- **Sign in** with email and password against any Steward server (URL entered on the sign-in screen). Two-factor verification with authenticator or recovery codes, and on-device TOTP enrollment when the workspace requires 2FA (hands the secret to your authenticator app).
- **Secure session**: the mobile bearer token (`client: "mobile"`, lifetime set by the server's `mobileSessionDays`) is stored in the iOS Keychain / Android Keystore via `expo-secure-store`. No cookies, no CSRF surface.
- **Biometric unlock** (Face ID, Touch ID, fingerprint) on launch and after 2 minutes in the background, opt-in from **More**.
- **Dashboard**: KPIs with change versus the previous period, revenue and signup charts, recent payments, signups and security events (`GET /api/admin/dashboard?days=30`).
- **Users**: search, status filters, infinite scroll, profile with subscriptions and payments; suspend, ban, reactivate and sign-out-everywhere actions (reasons are recorded in the audit log).
- **Billing**: subscriptions (cancel at period end) and payments with refunds. Large refunds go to a second approver per the server's separation-of-duties policy.
- **Alerts**: notification center (mark read, deep links) and security events (acknowledge or resolve).
- **Audit log** with filtering.
- **Role-aware**: tabs and actions the admin lacks permission for are hidden (from `/api/admin/auth/me`). The server enforces every permission regardless.
- **Sensitive actions** that the server marks as requiring recent re-authentication open a password (+ code) prompt and are retried automatically.
- Light and dark mode follow the system setting.

## Run it

The app is deliberately **outside the npm workspaces** (React Native's dependency tree is large and keeps its own lockfile):

```bash
cd apps/mobile
npm install --workspaces=false
npx expo start            # press "a" for Android or "i" for iOS
```

Native builds (`npm run android` / `npm run ios`) need Android Studio or Xcode; they run `expo prebuild` to generate the `android/` and `ios/` folders. Store builds: `npx eas build -p ios` / `-p android` (requires an Expo account), or build the prebuilt projects with Xcode/Gradle.

### Pointing it at a server

- Production: `https://admin.example.com` (HTTPS is required by iOS ATS and Android in release builds).
- Local development: Android emulator `http://10.0.2.2:4000`, iOS simulator `http://localhost:4000`, physical device `http://<your-computer-LAN-IP>:4000` (debug builds allow cleartext HTTP).

## Checks

```bash
npm run typecheck   # TypeScript, strict
npm test            # API client, formatting and permission helpers (uses the monorepo's vitest)
npx expo export --platform android --output-dir /tmp/steward-export   # Metro bundle check
```

## Structure

```
app/                 expo-router screens
  _layout.tsx        providers + session-based routing (sign-in / lock / app)
  sign-in.tsx        credentials, 2FA verification, 2FA enrollment
  lock.tsx           biometric gate
  (tabs)/            dashboard, users, billing, alerts, more
  user/[id].tsx      user profile and actions
  payment/[id].tsx   payment details and refunds
  audit.tsx          audit log
src/lib/             API client, formatting, permission helpers (pure TS, unit-tested)
src/auth/            session, secure storage, biometrics, re-authentication prompt
src/ui/              themed components and data hooks
```
