# Campus AV Gear Management System

## Refer Branch twist-code for the update code, but kindly refer to the readme.md, reasoning.md and ai_logs through the main branch only


A small Node.js + Express app for a college AV room: students browse the
catalog freely, but need an account to request gear; staff have a completely
separate login for approving requests, recording returns, and managing the
catalog.

## Run it on GitHub Codespaces

1. Push this folder to a GitHub repo (or open it as a repo).
2. Click **Code → Codespaces → Create codespace on main**.
3. The devcontainer runs `npm install` automatically. Once it finishes,
   run:
   ```bash
   npm start
   ```
4. Codespaces will pop up a "port forwarded" notification for port `3000` —
   click **Open in Browser**. That's the student catalog page
   (`index.html`). The staff desk is at `/staff.html`, linked from the
   bottom of the student page.

## Run it locally

```bash
npm install
npm start
```
Then open `http://localhost:3000`.

## Logins

**Students** — register their own account from the "Log in / Register"
button on the catalog page (name, email, password). No admin step needed.

**Staff** — a default account is seeded the first time the server starts:
- Email: `staff@avroom.local`
- Password: `admin123`

Log in at `/staff.html`, then add real staff accounts from the **Staff
accounts** tab and change/retire the default one. Staff and student logins
are separate systems on purpose — a student account can never see the
staff desk, and vice versa.

## What's where

- `server.js` — Express app and all API routes (auth, equipment, units,
  loans, settings).
- `db.js` — a tiny file-backed JSON store (`data/db.json`, created on first
  run). No external database needed, so it runs anywhere `npm install`
  works, Codespaces included. Swap it for a real database later if this
  needs to handle real concurrent traffic.
- `public/index.html` + `public/js/app.js` — the student-facing catalog,
  login/register modal, and "my loans" lookup.
- `public/staff.html` + `public/js/staff.js` — the staff login and
  dashboard (requests, active & overdue, equipment, staff accounts,
  settings).
- `public/css/style.css` — shared styling for both pages.

## How the core workflow maps to the app

- **Availability, not a paper register** — the catalog shows live
  available-unit counts per item, computed from real unit records.
- **Borrowing** — a logged-in student requests an item with a due date;
  the request sits as `pending` until staff act on it.
- **Approvals** — staff approve (which assigns a specific free unit and
  locks it) or reject a request from the **Requests** tab.
- **Returns & late fees** — the **Active & overdue** tab flags anything
  past its due date; recording a return auto-calculates the late fee
  (days late × the item's per-day rate) and the resulting deposit refund.
- **Deposits & limits** — each item has its own deposit and late-fee rate;
  the **Settings** tab controls the room-wide per-student active-loan
  limit.
- **Equipment & units** — staff add new gear/units and can flag a unit as
  under maintenance, pulling it out of the available pool without a fake
  loan.

## Notes

- Session cookies are used for login state; the session secret is a
  placeholder (`dev-only-secret-change-me` in `server.js`) — set a real
  `SESSION_SECRET` environment variable before deploying this anywhere
  other than a personal Codespace.
- `data/db.json` is gitignored so every fresh clone/Codespace starts from
  the seeded starter catalog and default staff login.
