# @steward/js

Browser SDK for self-service features: entitlements, usage meters, plans, checkout, subscription management, invoices and billing details. Zero dependencies.

It authenticates with a **customer session token** (`cs_...`) that your backend mints with `@steward/node` after it authenticates the user. Secret API keys are rejected.

```ts
import { StewardClient } from '@steward/js';

const steward = new StewardClient({
  baseUrl: 'https://admin.example.com',
  // Called when there is no token or it expired; concurrent calls share one refresh.
  getToken: async () => {
    const res = await fetch('/api/steward-session');
    return res.ok ? (await res.json()).token : null;
  },
  onUnauthorized: () => location.assign('/login'),
});

if (await steward.hasFeature('exports')) showExportButton();
const meters = await steward.usage();               // used / limit / forecast per meter
const plans = await steward.plans({ currency: 'USD' });
await steward.redirectToCheckout({ priceId: plans[1].prices[0].id, successUrl: location.href });

const [sub] = await steward.subscriptions.list();
await steward.subscriptions.change(sub.id, { priceId: annualPriceId });
await steward.subscriptions.cancel(sub.id, { reason: 'Not using it enough' }); // at period end

const invoices = await steward.invoices.list();
window.open(await steward.invoices.pdfUrl(invoices[0].id));
await steward.billingProfile.update({ address: { country: 'FR' }, taxId: 'FR12345678901' });

const notes = await steward.notifications.list();      // { supported, data } — needs the notifications module
const prefs = await steward.emailPreferences.get();    // { supported, data: { email, marketingConsent, categories } } — needs the email module
await steward.emailPreferences.setMarketing(false);    // unsubscribe from marketing; transactional email stays on
```

## Setup on the platform

Add your site's origin (e.g. `https://app.example.com`) to **Settings → API & webhooks → Client origins** so browsers may call the client API (CORS).

## Backend endpoint example

```ts
app.get('/api/steward-session', requireLogin, async (req, res) => {
  const { token, expiresAt } = await steward.customerSessions.create({ userId: req.user.stewardId, ttlMinutes: 30 });
  res.json({ token, expiresAt });
});
```
