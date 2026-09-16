const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { readDB, writeDB, uid, todayISO, addDaysISO, daysBetween } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));

// ---------------------------------------------------------------
// Seed a default staff account + starter catalog on first run
// ---------------------------------------------------------------
function seed() {
  const data = readDB();
  let changed = false;

  if (!data.users.find(u => u.role === 'staff')) {
    data.users.push({
      id: uid('u'),
      name: 'AV Room Staff',
      email: 'staff@avroom.local',
      passwordHash: bcrypt.hashSync('admin123', 10),
      role: 'staff',
      createdAt: new Date().toISOString()
    });
    changed = true;
  }

  if (data.equipment.length === 0) {
    const seedEquip = [
      { name: 'Canon DSLR Kit', category: 'Camera', description: 'Canon body, 18-55mm lens, spare battery, SD card.', depositAmount: 3000, lateFeePerDay: 100, maxLoanDays: 3, unitCount: 3 },
      { name: 'Epson Projector', category: 'Projector', description: 'HDMI + VGA, includes remote and cable.', depositAmount: 2000, lateFeePerDay: 80, maxLoanDays: 2, unitCount: 2 },
      { name: 'Rode Shotgun Mic', category: 'Audio', description: 'Camera-mount shotgun mic with windscreen.', depositAmount: 800, lateFeePerDay: 40, maxLoanDays: 3, unitCount: 4 },
      { name: 'Manfrotto Tripod', category: 'Support', description: 'Fluid-head tripod, holds up to 5kg.', depositAmount: 500, lateFeePerDay: 20, maxLoanDays: 3, unitCount: 5 }
    ];
    seedEquip.forEach(e => {
      const eq = {
        id: uid('eq'), name: e.name, category: e.category, description: e.description,
        depositAmount: e.depositAmount, lateFeePerDay: e.lateFeePerDay, maxLoanDays: e.maxLoanDays,
        createdAt: new Date().toISOString()
      };
      data.equipment.push(eq);
      for (let i = 1; i <= e.unitCount; i++) {
        data.units.push({ id: uid('un'), equipmentId: eq.id, label: e.name + ' #' + i, status: 'available' });
      }
    });
    changed = true;
  }

  if (changed) writeDB(data);
}
seed();

// ---------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in first.' });
  next();
}
function requireStaff(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'staff') {
    return res.status(403).json({ error: 'Staff login required.' });
  }
  next();
}
function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, role: u.role };
}

// ---------------------------------------------------------------
// Auth routes — students
// ---------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are all required.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password should be at least 6 characters.' });

  const data = readDB();
  if (data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'An account with that email already exists.' });
  }
  const user = {
    id: uid('u'), name: name.trim(), email: email.trim().toLowerCase(),
    passwordHash: bcrypt.hashSync(password, 10), role: 'student', createdAt: new Date().toISOString()
  };
  data.users.push(user);
  writeDB(data);
  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const data = readDB();
  const user = data.users.find(u => u.role === 'student' && u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------------------------------------------------------------
// Auth routes — staff (kept separate from student login on purpose)
// ---------------------------------------------------------------
app.post('/api/staff/login', (req, res) => {
  const { email, password } = req.body || {};
  const data = readDB();
  const user = data.users.find(u => u.role === 'staff' && u.email.toLowerCase() === (email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect staff email or password.' });
  }
  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});

// Staff can create additional staff accounts once logged in.
app.post('/api/staff/register', requireStaff, (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are all required.' });
  const data = readDB();
  if (data.users.find(u => u.email.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'An account with that email already exists.' });
  }
  const user = {
    id: uid('u'), name: name.trim(), email: email.trim().toLowerCase(),
    passwordHash: bcrypt.hashSync(password, 10), role: 'staff', createdAt: new Date().toISOString()
  };
  data.users.push(user);
  writeDB(data);
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------
// Equipment (catalog is public/read-only; writes are staff-only)
// ---------------------------------------------------------------
app.get('/api/equipment', (req, res) => {
  const data = readDB();
  const equipment = data.equipment.map(e => {
    const units = data.units.filter(u => u.equipmentId === e.id);
    return Object.assign({}, e, {
      totalUnits: units.length,
      availableUnits: units.filter(u => u.status === 'available').length
    });
  });
  res.json({ equipment });
});

app.get('/api/equipment/:id/units', requireStaff, (req, res) => {
  const data = readDB();
  res.json({ units: data.units.filter(u => u.equipmentId === req.params.id) });
});

app.post('/api/equipment', requireStaff, (req, res) => {
  const { name, category, description, depositAmount, lateFeePerDay, maxLoanDays, unitCount } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
  const data = readDB();
  const eq = {
    id: uid('eq'), name: name.trim(), category: (category || 'General').trim(), description: (description || '').trim(),
    depositAmount: Number(depositAmount) || 0, lateFeePerDay: Number(lateFeePerDay) || 0,
    maxLoanDays: Math.max(1, Number(maxLoanDays) || 7), createdAt: new Date().toISOString()
  };
  data.equipment.push(eq);
  const n = Math.max(1, Number(unitCount) || 1);
  for (let i = 1; i <= n; i++) {
    data.units.push({ id: uid('un'), equipmentId: eq.id, label: eq.name + ' #' + i, status: 'available' });
  }
  writeDB(data);
  res.json({ equipment: eq });
});

app.post('/api/equipment/:id/units', requireStaff, (req, res) => {
  const data = readDB();
  const eq = data.equipment.find(e => e.id === req.params.id);
  if (!eq) return res.status(404).json({ error: 'Equipment not found.' });
  const existing = data.units.filter(u => u.equipmentId === eq.id).length;
  const label = (req.body && req.body.label && req.body.label.trim()) || (eq.name + ' #' + (existing + 1));
  const unit = { id: uid('un'), equipmentId: eq.id, label, status: 'available' };
  data.units.push(unit);
  writeDB(data);
  res.json({ unit });
});

app.patch('/api/units/:id', requireStaff, (req, res) => {
  const data = readDB();
  const unit = data.units.find(u => u.id === req.params.id);
  if (!unit) return res.status(404).json({ error: 'Unit not found.' });
  if (unit.status === 'borrowed') return res.status(400).json({ error: 'This unit is currently on loan.' });
  unit.status = unit.status === 'maintenance' ? 'available' : 'maintenance';
  writeDB(data);
  res.json({ unit });
});

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------
app.get('/api/settings', requireStaff, (req, res) => {
  res.json({ settings: readDB().settings });
});

app.patch('/api/settings', requireStaff, (req, res) => {
  const data = readDB();
  const { maxActiveLoansPerBorrower, defaultLoanDays } = req.body || {};
  if (maxActiveLoansPerBorrower) data.settings.maxActiveLoansPerBorrower = Math.max(1, Number(maxActiveLoansPerBorrower));
  if (defaultLoanDays) data.settings.defaultLoanDays = Math.max(1, Number(defaultLoanDays));
  writeDB(data);
  res.json({ settings: data.settings });
});

// ---------------------------------------------------------------
// Loans — borrow requests, approvals, returns
// ---------------------------------------------------------------
app.post('/api/loans', requireAuth, (req, res) => {
  if (req.session.user.role !== 'student') return res.status(403).json({ error: 'Only student accounts can request gear.' });
  const { equipmentId, dueDate, note } = req.body || {};
  const data = readDB();
  const eq = data.equipment.find(e => e.id === equipmentId);
  if (!eq) return res.status(404).json({ error: 'Equipment not found.' });

  const activeCount = data.loans.filter(l =>
    l.borrowerId === req.session.user.id && (l.status === 'pending' || l.status === 'approved')
  ).length;
  if (activeCount >= data.settings.maxActiveLoansPerBorrower) {
    return res.status(400).json({ error: 'You already have ' + activeCount + ' active loan(s), which is the room\'s limit (' + data.settings.maxActiveLoansPerBorrower + ').' });
  }

  const availableUnits = data.units.filter(u => u.equipmentId === equipmentId && u.status === 'available').length;
  if (availableUnits === 0) return res.status(400).json({ error: 'No units of this item are available right now.' });

  const loan = {
    id: uid('ln'), equipmentId, equipmentName: eq.name, unitId: null, unitLabel: null,
    borrowerId: req.session.user.id, borrowerName: req.session.user.name, borrowerEmail: req.session.user.email,
    note: (note || '').trim(), requestedAt: new Date().toISOString(),
    dueDate: dueDate || addDaysISO(todayISO(), eq.maxLoanDays),
    approvedAt: null, returnedAt: null, status: 'pending',
    depositAmount: eq.depositAmount, lateFeePerDay: eq.lateFeePerDay, lateFeeCharged: 0, depositRefunded: null
  };
  data.loans.push(loan);
  writeDB(data);
  res.json({ loan });
});

app.get('/api/loans/mine', requireAuth, (req, res) => {
  const data = readDB();
  const mine = data.loans
    .filter(l => l.borrowerId === req.session.user.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  res.json({ loans: mine });
});

app.get('/api/loans', requireStaff, (req, res) => {
  const data = readDB();
  let loans = data.loans;
  if (req.query.status) loans = loans.filter(l => l.status === req.query.status);
  loans = loans.slice().sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  res.json({ loans });
});

app.patch('/api/loans/:id/approve', requireStaff, (req, res) => {
  const data = readDB();
  const loan = data.loans.find(l => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found.' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be approved.' });

  const unit = data.units.find(u => u.equipmentId === loan.equipmentId && u.status === 'available');
  if (!unit) return res.status(400).json({ error: 'No free unit left to assign.' });

  unit.status = 'borrowed';
  loan.status = 'approved';
  loan.unitId = unit.id;
  loan.unitLabel = unit.label;
  loan.approvedAt = new Date().toISOString();
  writeDB(data);
  res.json({ loan });
});

app.patch('/api/loans/:id/reject', requireStaff, (req, res) => {
  const data = readDB();
  const loan = data.loans.find(l => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found.' });
  if (loan.status !== 'pending') return res.status(400).json({ error: 'Only pending requests can be rejected.' });
  loan.status = 'rejected';
  writeDB(data);
  res.json({ loan });
});

app.patch('/api/loans/:id/return', requireStaff, (req, res) => {
  const data = readDB();
  const loan = data.loans.find(l => l.id === req.params.id);
  if (!loan) return res.status(404).json({ error: 'Loan not found.' });
  if (loan.status !== 'approved') return res.status(400).json({ error: 'Only active loans can be returned.' });

  const today = todayISO();
  const daysLate = loan.dueDate < today ? daysBetween(loan.dueDate, today) : 0;
  const lateFee = daysLate * loan.lateFeePerDay;
  const refund = Math.max(0, loan.depositAmount - lateFee);

  if (loan.unitId) {
    const unit = data.units.find(u => u.id === loan.unitId);
    if (unit) unit.status = 'available';
  }
  loan.status = 'returned';
  loan.returnedAt = new Date().toISOString();
  loan.lateFeeCharged = lateFee;
  loan.depositRefunded = refund;
  writeDB(data);
  res.json({ loan });
});

app.listen(PORT, () => {
  console.log('AV Room server running at http://localhost:' + PORT);
  console.log('Default staff login -> email: staff@avroom.local  password: admin123');
});
