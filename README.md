# Dispatch tracker

Order-dispatch tracker for routing confirmed orders to warehouses (Badda,
Multiplan, CTG, and whatever else gets added later). Capture an order ID
from a right-click browser extension, or type it in manually; it lands in
a shared, real-time dashboard grouped by date, with bulk-complete and
export-to-text per date.

Same shape as [messenger-capture](https://github.com/samin-isnotavailable/messenger-capture):
Vite + vanilla JS dashboard, Supabase for auth/DB/realtime, Vercel hosting,
and a Manifest v3 browser extension for capture.

## Roles

- **super_admin** (you) — sees every warehouse, is the only one who can add
  new warehouses, can add/edit orders in any warehouse.
- **staff** — lands on their assigned warehouse on login, can browse other
  warehouses read-only, can only add/check off orders in their own
  warehouse.

## 1. Set up Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run `supabase/migrations/0001_init.sql`. This
   creates the `warehouses`, `profiles`, and `orders` tables, sets up row
   level security, and seeds Badda / Multiplan / CTG.
3. Go to **Authentication → Users** and manually invite/create an account
   for yourself and each staff member (email + password is enough).
4. For each user, go to **Table editor → profiles** and set:
   - `role` to `super_admin` (just you) or `staff` (everyone else)
   - `warehouse_id` to the staff member's assigned warehouse (leave blank
     for super_admin)
5. Copy your **Project URL** and **anon public key** from
   **Settings → API** — you'll need both below.

There's no admin UI for assigning roles yet (see Notes) — do it from the
Supabase table editor for now.

## 2. Run the dashboard locally

```
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env
npm run dev
```

## 3. Deploy to Vercel

Push this repo to GitHub, import it in Vercel, and set the same two
environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`) in
the Vercel project settings. Vercel auto-detects the Vite build.

## 4. Install the browser extension

1. Open `messenger-extension/config.js` and fill in the same
   `SUPABASE_URL` and `SUPABASE_ANON_KEY` you used in `.env`.
2. In Chrome/Brave, go to `chrome://extensions`, enable **Developer mode**,
   click **Load unpacked**, and select the `messenger-extension/` folder.
3. Click the extension icon, sign in with your Supabase account.
4. Select an order ID on any page, right-click → **Send to warehouse** →
   pick the warehouse. A ✓ badge confirms it landed; a ✓ shows briefly
   over the toolbar icon.

The extension's right-click menu is built from the live `warehouses`
table (refreshes every 30 minutes, or immediately after sign-in), so
adding a warehouse in the dashboard shows up in the menu without
reinstalling the extension.

## Project structure

```
dispatch-tracker/
├── src/                    # Dashboard (Vite + vanilla JS)
│   ├── main.js
│   ├── auth.js
│   ├── dashboard.js
│   ├── supabaseClient.js
│   └── style.css
├── messenger-extension/    # Browser extension (Manifest v3)
│   ├── manifest.json
│   ├── background.js       # builds the context menu, saves captures
│   ├── authClient.js        # Supabase Auth REST calls + token refresh
│   ├── popup.html / popup.js
│   └── config.js
├── supabase/migrations/0001_init.sql
└── index.html
```

## Notes / next steps

- **Admin UI for staff/warehouse management** isn't built yet — role and
  warehouse assignment happens in the Supabase table editor. Worth adding
  a simple admin screen once the core flow is proven out day-to-day.
- **Export** downloads a `.txt` file (`Warehouse_Date.txt`, one order ID
  per line) and also copies the same text to your clipboard.
- RLS is the source of truth for permissions — even if the UI has a bug,
  a staff member's Supabase session physically cannot write outside their
  assigned warehouse.
