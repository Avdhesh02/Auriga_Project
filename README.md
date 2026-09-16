# Campus AV Gear Management System

A lending desk for the college AV room. Students see what is actually free and
request it; staff approve, record returns, work out late fees and deposits, and
keep the inventory straight. An active loan can also be handed from one student
to another without the gear coming back to the room.

Node.js + Express on the server, **SQLite** for storage, plain HTML/CSS/JS on
the front end (no build step).

---

## Run it

### GitHub Codespaces

1. Push this folder to a GitHub repo.
2. **Code → Codespaces → Create codespace on main**.
3. The devcontainer runs `npm install` on its own. When it finishes:
   ```bash
   npm start
   ```
4. Codespaces forwards port `3000` — open it. That is the student catalog.
   The staff desk is at `/staff.html`.

### Locally

```bash
npm install
npm start          # http://localhost:3000
```

Useful extras:

```bash
npm run demo       # load a believable afternoon of activity (see below)
npm test           # run the rule checks
npm run reset      # wipe the database and start from the seeded catalog
```

## Logins

**Staff** — seeded on first start:

| Email | Password |
| --- | --- |
| `staff@avroom.local` | `admin123` |

Change it from **Staff accounts → New password** once you are in, and add real
staff there too.

**Students** register themselves from the catalog page. `npm run demo` also
creates four students (`asha@college.edu`, `ravi@college.edu`,
`meera@college.edu`, `dev@college.edu`) with the password `student123`.

Student and staff logins are separate on purpose: a student account cannot open
the staff desk, and a staff account cannot book gear out for itself.

---

## The database

Storage is SQLite, in `data/avroom.db`, created on first run.

`npm install` fetches `better-sqlite3`, which ships prebuilt binaries, so there
is nothing to compile. If that fails on your machine, `db.js` falls back to
Node's built-in `node:sqlite` (Node 22.13+ / 24+) with no code changes — the
server prints which driver it picked at startup.

Six tables, with foreign keys, CHECK constraints and indexes:

```
users ──────┐
            ├──< loans >──── equipment ──< units
            │        │                       ▲
            │        └───────────────────────┘  (loans.unit_id: the exact unit
            │                                    handed over)
            └──< loan_transfers >── loans        (who passed what to whom)

settings    (room-wide rules: loan limit, default length, handovers on/off)
```

Things the database enforces by itself, rather than trusting the app code:

- A unit can be on only one live loan: a partial unique index on
  `loans(unit_id) WHERE status = 'approved'`.
- Statuses can only be real statuses (`CHECK` constraints on loans, units,
  transfers and roles).
- Deposits, late-fee rates and loan lengths cannot go negative.
- Approvals, returns and handovers run inside `BEGIN IMMEDIATE` transactions, so
  a half-finished handover cannot exist.

Availability is never stored as a number. It is counted from the `units` table
every time the catalog is read, which is why the count on the page cannot drift
away from what is on the shelf.

## What's where

| File | What it does |
| --- | --- |
| `server.js` | Express app: sessions, access rules, and the HTTP routes. Nothing else. |
| `store.js` | Every room rule: availability, limits, approvals, returns, fees, handovers. |
| `db.js` | SQLite connection, schema, transactions, date helpers. |
| `public/index.html`, `public/js/app.js` | Student catalog, requests, my loans, handovers. |
| `public/staff.html`, `public/js/staff.js` | Staff desk: requests, out & overdue, handovers, equipment, accounts, rules. |
| `public/css/style.css` | Shared styling. |
| `scripts/demo-data.js` | Loads a realistic set of loans for a demo. |
| `scripts/reset-db.js` | Deletes the database file. |
| `tests/logic.test.js` | 42 checks over the rules, including the handover ones. |

---

## How the room's problems map to the app

**"Is a DSLR free this weekend?"** — the catalog shows live free counts per
item, and a date box: pick Saturday and the list narrows to gear that is free
now or due back before then. When everything is out, the card says when the
next one is due back.

**Two clubs, one projector** — a request holds a place in the queue, and the
desk cannot promise more units than exist. Approving assigns one specific
numbered unit and marks it out.

**Return dates and late fees** — every item has its own maximum loan length, so
a request cannot be made open-ended. The **Out & overdue** tab sorts by return
date, oldest first, and **Remind** produces a ready-to-send message for the
person holding it.

**Deposits** — each item carries its own deposit and per-day rate. Recording a
return works out days late × rate, subtracts it from the deposit and shows the
refund before anything is saved. The amounts on a loan are frozen at the moment
it was made, so changing a price later does not rewrite history.

**Nobody books out half the room** — one room-wide setting caps how many open
requests and loans a student can have at a time, and it is checked when they
request, when staff approve, and when a loan is handed to them.

**Not a paper register** — gear under repair is marked as such, which pulls it
out of the free count without anyone inventing a fake loan.

---

## The twist: handing a loan to someone else

An active loan can move to another borrower. **The return date carries over
untouched, and availability does not change** — the item never returns to the
shelf, so no count moves and nobody else can slip in and book it mid-swap.

Two ways to do it:

- **Student to student** — on **My loans**, *Hand over*. The other person gets
  it on their **Handovers** tab and has to accept, because they are taking on
  the return date, the deposit and any late fee. Until they accept, nothing
  changes.
- **At the desk** — on **Out & overdue**, *Hand over*. Staff are watching the
  swap happen, so it applies straight away.

What the code refuses to do:

- move a loan that is not currently out;
- move it to someone already at the loan limit, to an inactive account, or to
  the person who already has it;
- let anyone but the named recipient accept;
- let someone hand over a loan that has already moved on (the handover is
  matched against the current borrower, not the one from when it was sent);
- change the due date or the unit — after every handover the code re-reads the
  loan and rolls the whole thing back if either moved.

Everything is kept in `loan_transfers`, so a loan carries its full chain: who
started it, everyone it passed through, and who is holding it now. The desk
sees that chain on the loan, which matters when something comes back broken.

`npm run demo` leaves one handover waiting: log in as `ravi@college.edu`
(`student123`) and accept the camera. The return date and the catalog count
both stay exactly where they were.

---

## Notes

- Sessions are cookie-based. The secret falls back to a placeholder — set a real
  `SESSION_SECRET` before running this anywhere public.
- `data/` is gitignored, so a fresh clone starts from the seeded catalog and the
  default staff login.
- Passwords are stored as bcrypt hashes, never in the clear.
- This is sized for one AV room on one server. The schema is ordinary SQL, so
  moving to Postgres later is mostly swapping the driver in `db.js`.
