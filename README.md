# DispatchEZ

Order-dispatch tracker for routing confirmed orders to warehouses. Capture
an order ID with a right-click browser extension or type it in manually —
it lands in a shared, real-time dashboard grouped by date, with per-date
bulk-complete and export-to-text.

**Live:** [dispatchez.vercel.app](https://dispatchez.vercel.app/)

Built with the same stack as its sibling tool,
[messenger-capture](https://github.com/samin-isnotavailable/messenger-capture):
Vite + vanilla JS, Supabase (auth/DB/realtime), Vercel hosting, and a
Manifest v3 browser extension for capture.

---

## Features

- **Warehouse tabs** — dynamic, driven by a `warehouses` table, not
  hardcoded. Add a new warehouse from the dashboard and it shows up
  everywhere (including the extension's context menu) without a redeploy.
- **Two entry points** — a browser extension (select text → right-click →
  send to a warehouse) and a manual add box in the dashboard, with
  Enter-to-submit for fast repeated entry.
- **Date-grouped orders** — each day gets its own card with a live count,
  a "mark all complete" bulk action, and a one-click export to a plain
  `.txt` list of order IDs (also copied to clipboard).
- **Real-time sync** — every connected browser sees new/updated/deleted
  orders instantly via Supabase Realtime, no polling or manual refresh.
- **Role-based access** — `super_admin` sees and manages every warehouse;
  `staff` land directly on their assigned warehouse, can browse others
  read-only, and can only add/edit/delete within their own. Enforced by
  Postgres Row Level Security, not just UI conditionals — the rules hold
  even if the frontend has a bug.
- **Personal notes** — a private, autosaving scratchpad per user.

## Tech stack

| Layer      | Choice                                    |
|------------|--------------------------------------------|
| Frontend   | Vite + vanilla JS                          |
| Backend    | Supabase (Postgres, Auth, Realtime, RLS)   |
| Hosting    | Vercel                                     |
| Extension  | Chrome/Brave, Manifest v3                  |

## Roles

- **super_admin** — sees every warehouse, is the only role that can add
  new warehouses, can add/edit/delete orders in any warehouse.
- **staff** — lands on their assigned warehouse on login, can browse
  other warehouses read-only, can only add/check off orders in their own
  warehouse.

---

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. Open the SQL editor and run, in order:
   - `supabase/migrations/0001_init.sql` — creates `warehouses`,
     `profiles`, `orders`, sets up RLS, and seeds a few starter
     warehouses.
   - `supabase/migrations/0002_notes.sql` — adds the personal notes
     table.
3. **Authentication → Users** — create an account for yourself and each
   staff member (email + password is enough).
4. **Table editor → profiles** — for each user, set:
   - `role` → `super_admin` (you) or `staff` (everyone else)
   - `warehouse_id` → the staff member's assigned warehouse (leave blank
     for super_admin)
5. **Settings → API** — copy the **Project URL** and **anon public key**
   (you'll need both next).

> There's no admin UI for assigning roles yet — do it from the Supabase
> table editor for now. See [Roadmap](#roadmap).

### 2. Dashboard (local)

```bash
npm install
cp .env.example .env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
npm run dev
```

### 3. Deploy

Push to GitHub, import the repo in Vercel, and set the same two
environment variables in the Vercel project settings. Vercel auto-detects
the Vite build.

### 4. Browser extension

1. Open `copy-extension/config.js` and fill in the same
   `SUPABASE_URL` / `SUPABASE_ANON_KEY` values as your `.env`.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked**
   → select the `copy-extension/` folder.
3. Click the extension icon and sign in.
4. Select an order ID on any page → right-click → **Send to warehouse**.

The context menu is built from the live `warehouses` table (refreshes
every 30 minutes, or immediately after sign-in), so new warehouses appear
without reinstalling the extension.

---

## Project structure

```
dispatchez/
├── src/                     # Dashboard (Vite + vanilla JS)
│   ├── main.js
│   ├── auth.js
│   ├── dashboard.js
│   ├── supabaseClient.js
│   └── style.css
├── copy-extension/     # Browser extension (Manifest v3)
│   ├── manifest.json
│   ├── background.js        # builds the context menu, saves captures
│   ├── authClient.js         # Supabase Auth REST calls + token refresh
│   ├── popup.html / popup.js
│   └── config.js
├── supabase/migrations/
│   ├── 0001_init.sql
│   └── 0002_notes.sql
└── index.html
```

## Roadmap

- Admin UI for assigning staff roles/warehouses (currently Supabase
  table editor only)
- Bulk import of order IDs
- Per-warehouse export history / archive view

## License

[MIT](LICENSE) — use it, fork it, adapt it, just keep the copyright notice.
