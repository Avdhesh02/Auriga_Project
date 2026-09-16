'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');

const db = require('./db');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

store.seed();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'avroom.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 }
}));

// ---------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------
function ok(res, payload) { res.json(payload); }

// Wraps a handler so any thrown error becomes a clean JSON response.
function handle(fn) {
  return function (req, res) {
    try {
      fn(req, res);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || 'Something went wrong.' });
    }
  };
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Log in first.' });
  next();
}
function requireStudent(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ error: 'Student login required.' });
  }
  next();
}
function requireStaff(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Staff login required.' });
  }
  next();
}

// ---------------------------------------------------------------
// Auth — students
// ---------------------------------------------------------------
app.post('/api/auth/register', handle(function (req, res) {
  const user = store.createUser(Object.assign({}, req.body, { role: 'student' }));
  req.session.user = user;
  ok(res, { user: user });
}));

app.post('/api/auth/login', handle(function (req, res) {
  const body = req.body || {};
  const user = store.authenticate(body.email, body.password, 'student');
  req.session.user = user;
  ok(res, { user: user });
}));

app.post('/api/auth/logout', function (req, res) {
  req.session.destroy(function () { res.json({ ok: true }); });
});

app.get('/api/auth/me', function (req, res) {
  res.json({ user: req.session.user || null });
});

app.patch('/api/auth/password', requireAuth, handle(function (req, res) {
  store.authenticate(req.session.user.email, (req.body || {}).currentPassword, req.session.user.role);
  store.changePassword(req.session.user.id, (req.body || {}).newPassword);
  ok(res, { ok: true });
}));

// ---------------------------------------------------------------
// Auth — staff (a separate door on purpose)
// ---------------------------------------------------------------
app.post('/api/staff/login', handle(function (req, res) {
  const body = req.body || {};
  const user = store.authenticate(body.email, body.password, 'staff');
  req.session.user = user;
  ok(res, { user: user });
}));

app.get('/api/staff', requireStaff, handle(function (req, res) {
  ok(res, { staff: store.listUsers('staff') });
}));

app.post('/api/staff/register', requireStaff, handle(function (req, res) {
  ok(res, { user: store.createUser(Object.assign({}, req.body, { role: 'staff' })) });
}));

app.patch('/api/staff/:id/active', requireStaff, handle(function (req, res) {
  const active = !!(req.body || {}).active;
  ok(res, { user: store.setStaffActive(req.params.id, active, req.session.user.id) });
}));

app.patch('/api/staff/:id/password', requireStaff, handle(function (req, res) {
  ok(res, { user: store.changePassword(req.params.id, (req.body || {}).newPassword) });
}));

app.get('/api/students', requireStaff, handle(function (req, res) {
  ok(res, { students: store.listUsers('student') });
}));

app.get('/api/students/search', requireAuth, handle(function (req, res) {
  ok(res, { students: store.searchStudents(req.query.q, req.session.user.id) });
}));

// ---------------------------------------------------------------
// Catalog — reading is open to anyone, writing is staff-only
// ---------------------------------------------------------------
app.get('/api/equipment', handle(function (req, res) {
  ok(res, { equipment: store.listEquipment({ includeRetired: req.query.all === '1' }) });
}));

app.post('/api/equipment', requireStaff, handle(function (req, res) {
  ok(res, { equipment: store.createEquipment(req.body || {}) });
}));

app.patch('/api/equipment/:id', requireStaff, handle(function (req, res) {
  ok(res, { equipment: store.updateEquipment(req.params.id, req.body || {}) });
}));

app.get('/api/equipment/:id/units', requireStaff, handle(function (req, res) {
  ok(res, { units: store.listUnits(req.params.id) });
}));

app.post('/api/equipment/:id/units', requireStaff, handle(function (req, res) {
  ok(res, { unit: store.addUnit(req.params.id, (req.body || {}).label) });
}));

app.patch('/api/units/:id/maintenance', requireStaff, handle(function (req, res) {
  ok(res, { unit: store.toggleUnitMaintenance(req.params.id) });
}));

app.delete('/api/units/:id', requireStaff, handle(function (req, res) {
  ok(res, store.deleteUnit(req.params.id));
}));

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------
app.get('/api/settings', requireAuth, handle(function (req, res) {
  ok(res, { settings: store.getSettings() });
}));

app.patch('/api/settings', requireStaff, handle(function (req, res) {
  ok(res, { settings: store.updateSettings(req.body || {}) });
}));

app.get('/api/stats', requireStaff, handle(function (req, res) {
  ok(res, { stats: store.deskStats() });
}));

// ---------------------------------------------------------------
// Loans
// ---------------------------------------------------------------
app.post('/api/loans', requireStudent, handle(function (req, res) {
  ok(res, { loan: store.requestLoan(req.session.user, req.body || {}) });
}));

app.get('/api/loans/mine', requireAuth, handle(function (req, res) {
  ok(res, { loans: store.listLoansForUser(req.session.user.id) });
}));

app.get('/api/loans', requireStaff, handle(function (req, res) {
  ok(res, {
    loans: store.listLoans({
      status: req.query.status,
      overdue: req.query.overdue === '1',
      q: req.query.q
    })
  });
}));

app.get('/api/loans/:id', requireAuth, handle(function (req, res) {
  const loan = store.getLoan(req.params.id);
  if (req.session.user.role !== 'staff' && loan.borrowerId !== req.session.user.id) {
    return res.status(403).json({ error: 'That loan is not yours.' });
  }
  ok(res, { loan: loan, transfers: store.listTransfers({ loanId: loan.id }) });
}));

app.patch('/api/loans/:id/approve', requireStaff, handle(function (req, res) {
  ok(res, { loan: store.approveLoan(req.params.id, req.session.user) });
}));

app.patch('/api/loans/:id/reject', requireStaff, handle(function (req, res) {
  ok(res, { loan: store.rejectLoan(req.params.id, req.session.user, (req.body || {}).reason) });
}));

app.patch('/api/loans/:id/cancel', requireAuth, handle(function (req, res) {
  ok(res, { loan: store.cancelLoan(req.params.id, req.session.user) });
}));

app.patch('/api/loans/:id/return', requireStaff, handle(function (req, res) {
  ok(res, { loan: store.returnLoan(req.params.id, req.session.user) });
}));

app.post('/api/loans/:id/nudge', requireStaff, handle(function (req, res) {
  ok(res, store.nudgeLoan(req.params.id));
}));

// ---------------------------------------------------------------
// Handovers (the transfer twist)
// ---------------------------------------------------------------
app.post('/api/loans/:id/transfers', requireAuth, handle(function (req, res) {
  ok(res, store.startTransfer(req.session.user, req.params.id, req.body || {}));
}));

app.get('/api/transfers/mine', requireAuth, handle(function (req, res) {
  const all = store.listTransfers({ userId: req.session.user.id });
  ok(res, {
    incoming: all.filter(function (t) { return t.toUserId === req.session.user.id; }),
    outgoing: all.filter(function (t) { return t.fromUserId === req.session.user.id; })
  });
}));

app.get('/api/transfers', requireStaff, handle(function (req, res) {
  ok(res, { transfers: store.listTransfers({ status: req.query.status }) });
}));

app.patch('/api/transfers/:id/accept', requireAuth, handle(function (req, res) {
  ok(res, store.acceptTransfer(req.params.id, req.session.user));
}));

app.patch('/api/transfers/:id/reject', requireAuth, handle(function (req, res) {
  ok(res, { transfer: store.rejectTransfer(req.params.id, req.session.user) });
}));

app.patch('/api/transfers/:id/cancel', requireAuth, handle(function (req, res) {
  ok(res, { transfer: store.cancelTransfer(req.params.id, req.session.user) });
}));

// ---------------------------------------------------------------
app.use('/api', function (req, res) {
  res.status(404).json({ error: 'No such endpoint: ' + req.method + ' ' + req.originalUrl });
});

if (require.main === module) {
  app.listen(PORT, function () {
    console.log('AV room desk running on http://localhost:' + PORT);
    console.log('Database: ' + db.file + '  (driver: ' + db.driver + ')');
    console.log('Default staff login -> staff@avroom.local / admin123');
  });
}

module.exports = app;
