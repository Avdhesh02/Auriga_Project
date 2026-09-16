'use strict';

/**
 * Every rule the AV room cares about lives here: availability, loan limits,
 * approvals, returns, late fees, deposits and handovers. server.js only does
 * HTTP — it parses a request, calls one of these functions, and sends back
 * whatever comes out (or the error).
 */

const bcrypt = require('bcryptjs');
const db = require('./db');

const { uid, nowISO, todayISO, addDaysISO, daysBetween } = db;

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------
const SETTING_DEFAULTS = {
  maxActiveLoansPerBorrower: 3,
  defaultLoanDays: 7,
  allowStudentTransfers: 1
};

function getSettings() {
  const rows = db.all('SELECT key, value FROM settings');
  const out = Object.assign({}, SETTING_DEFAULTS);
  rows.forEach(function (r) { out[r.key] = Number(r.value); });
  return {
    maxActiveLoansPerBorrower: Number(out.maxActiveLoansPerBorrower),
    defaultLoanDays: Number(out.defaultLoanDays),
    allowStudentTransfers: Number(out.allowStudentTransfers) === 1
  };
}

function setSetting(key, value) {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, String(value)]
  );
}

function updateSettings(patch) {
  db.transaction(function () {
    if (patch.maxActiveLoansPerBorrower != null) {
      setSetting('maxActiveLoansPerBorrower', Math.max(1, Math.min(20, Number(patch.maxActiveLoansPerBorrower) || 1)));
    }
    if (patch.defaultLoanDays != null) {
      setSetting('defaultLoanDays', Math.max(1, Math.min(90, Number(patch.defaultLoanDays) || 1)));
    }
    if (patch.allowStudentTransfers != null) {
      setSetting('allowStudentTransfers', patch.allowStudentTransfers ? 1 : 0);
    }
  });
  return getSettings();
}

// ---------------------------------------------------------------
// Users
// ---------------------------------------------------------------
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, active: row.active === 1 };
}

function getUserById(id) {
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

function getUserByEmail(email, role) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return null;
  if (role) return db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE AND role = ?', [clean, role]);
  return db.get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', [clean]);
}

function createUser(input) {
  const name = String(input.name || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const password = String(input.password || '');
  const role = input.role === 'staff' ? 'staff' : 'student';

  if (!name || !email || !password) throw fail(400, 'Name, email and password are all required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'That email address does not look right.');
  if (password.length < 6) throw fail(400, 'Use a password of at least 6 characters.');
  if (getUserByEmail(email)) throw fail(409, 'An account with that email already exists.');

  const user = {
    id: uid('u'),
    name: name,
    email: email,
    password_hash: bcrypt.hashSync(password, 10),
    role: role,
    active: 1,
    created_at: nowISO()
  };
  db.run(
    'INSERT INTO users (id, name, email, password_hash, role, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [user.id, user.name, user.email, user.password_hash, user.role, user.active, user.created_at]
  );
  return publicUser(user);
}

function authenticate(email, password, role) {
  const row = getUserByEmail(email, role);
  if (!row || !bcrypt.compareSync(String(password || ''), row.password_hash)) {
    throw fail(401, role === 'staff' ? 'Incorrect staff email or password.' : 'Incorrect email or password.');
  }
  if (row.active !== 1) throw fail(403, 'That account has been switched off. Ask the AV desk.');
  return publicUser(row);
}

function listUsers(role) {
  return db.all(
    'SELECT id, name, email, role, active, created_at FROM users WHERE role = ? ORDER BY name COLLATE NOCASE',
    [role]
  ).map(function (r) {
    return { id: r.id, name: r.name, email: r.email, role: r.role, active: r.active === 1, createdAt: r.created_at };
  });
}

function searchStudents(query, excludeId) {
  const q = '%' + String(query || '').trim().toLowerCase() + '%';
  return db.all(
    "SELECT id, name, email FROM users " +
    "WHERE role = 'student' AND active = 1 AND id != ? AND (lower(name) LIKE ? OR lower(email) LIKE ?) " +
    'ORDER BY name COLLATE NOCASE LIMIT 8',
    [excludeId || '', q, q]
  );
}

function setStaffActive(staffId, active, actingStaffId) {
  const row = getUserById(staffId);
  if (!row || row.role !== 'staff') throw fail(404, 'Staff account not found.');
  if (staffId === actingStaffId && !active) throw fail(400, 'You cannot switch off the account you are signed in with.');
  if (!active) {
    const others = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'staff' AND active = 1 AND id != ?", [staffId]);
    if (others.n === 0) throw fail(400, 'This is the last active staff account — keep at least one.');
  }
  db.run('UPDATE users SET active = ? WHERE id = ?', [active ? 1 : 0, staffId]);
  return publicUser(getUserById(staffId));
}

function changePassword(userId, newPassword) {
  if (String(newPassword || '').length < 6) throw fail(400, 'Use a password of at least 6 characters.');
  const row = getUserById(userId);
  if (!row) throw fail(404, 'Account not found.');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(String(newPassword), 10), userId]);
  return publicUser(row);
}

// ---------------------------------------------------------------
// Equipment + units
// ---------------------------------------------------------------
function equipmentRowToApi(e) {
  return {
    id: e.id,
    name: e.name,
    category: e.category,
    description: e.description,
    depositAmount: e.deposit_amount,
    lateFeePerDay: e.late_fee_per_day,
    maxLoanDays: e.max_loan_days,
    retired: e.retired === 1,
    createdAt: e.created_at
  };
}

/**
 * The catalog view: live counts straight out of the unit table, plus the
 * dates units are due back, so the page can answer "is one free on Saturday?"
 * instead of "ask at the desk".
 */
function listEquipment(options) {
  const opts = options || {};
  const rows = db.all(
    'SELECT * FROM equipment' + (opts.includeRetired ? '' : ' WHERE retired = 0') +
    ' ORDER BY name COLLATE NOCASE'
  );

  const counts = db.all(
    'SELECT equipment_id, status, COUNT(*) AS n FROM units GROUP BY equipment_id, status'
  );
  const dueRows = db.all(
    "SELECT equipment_id, due_date FROM loans WHERE status = 'approved' ORDER BY due_date"
  );

  return rows.map(function (e) {
    const mine = counts.filter(function (c) { return c.equipment_id === e.id; });
    const byStatus = function (s) {
      const hit = mine.find(function (c) { return c.status === s; });
      return hit ? hit.n : 0;
    };
    const dueDates = dueRows
      .filter(function (d) { return d.equipment_id === e.id; })
      .map(function (d) { return d.due_date; });

    const available = byStatus('available');
    return Object.assign(equipmentRowToApi(e), {
      totalUnits: mine.reduce(function (s, c) { return s + c.n; }, 0),
      availableUnits: available,
      borrowedUnits: byStatus('borrowed'),
      maintenanceUnits: byStatus('maintenance'),
      dueDates: dueDates,
      nextFreeDate: available > 0 ? todayISO() : (dueDates[0] || null)
    });
  });
}

function getEquipment(id) {
  const row = db.get('SELECT * FROM equipment WHERE id = ?', [id]);
  if (!row) throw fail(404, 'That item is not in the catalog.');
  return row;
}

function createEquipment(input) {
  const name = String(input.name || '').trim();
  if (!name) throw fail(400, 'Give the item a name.');
  const unitCount = Math.max(1, Math.min(50, Number(input.unitCount) || 1));

  const eq = {
    id: uid('eq'),
    name: name,
    category: String(input.category || 'General').trim() || 'General',
    description: String(input.description || '').trim(),
    deposit_amount: Math.max(0, Number(input.depositAmount) || 0),
    late_fee_per_day: Math.max(0, Number(input.lateFeePerDay) || 0),
    max_loan_days: Math.max(1, Number(input.maxLoanDays) || 7),
    created_at: nowISO()
  };

  return db.transaction(function () {
    db.run(
      'INSERT INTO equipment (id, name, category, description, deposit_amount, late_fee_per_day, max_loan_days, retired, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      [eq.id, eq.name, eq.category, eq.description, eq.deposit_amount, eq.late_fee_per_day, eq.max_loan_days, eq.created_at]
    );
    for (let i = 1; i <= unitCount; i++) {
      db.run('INSERT INTO units (id, equipment_id, label, status, created_at) VALUES (?, ?, ?, ?, ?)',
        [uid('un'), eq.id, eq.name + ' #' + i, 'available', nowISO()]);
    }
    return equipmentRowToApi(eq);
  });
}

function updateEquipment(id, patch) {
  const eq = getEquipment(id);
  const next = {
    name: patch.name != null ? String(patch.name).trim() : eq.name,
    category: patch.category != null ? String(patch.category).trim() : eq.category,
    description: patch.description != null ? String(patch.description).trim() : eq.description,
    deposit_amount: patch.depositAmount != null ? Math.max(0, Number(patch.depositAmount) || 0) : eq.deposit_amount,
    late_fee_per_day: patch.lateFeePerDay != null ? Math.max(0, Number(patch.lateFeePerDay) || 0) : eq.late_fee_per_day,
    max_loan_days: patch.maxLoanDays != null ? Math.max(1, Number(patch.maxLoanDays) || 1) : eq.max_loan_days,
    retired: patch.retired != null ? (patch.retired ? 1 : 0) : eq.retired
  };
  if (!next.name) throw fail(400, 'Give the item a name.');
  if (next.retired === 1) {
    const live = db.get("SELECT COUNT(*) AS n FROM loans WHERE equipment_id = ? AND status IN ('pending','approved')", [id]);
    if (live.n > 0) throw fail(400, 'Clear the ' + live.n + ' open loan(s) on this item before retiring it.');
  }
  db.run(
    'UPDATE equipment SET name = ?, category = ?, description = ?, deposit_amount = ?, late_fee_per_day = ?, max_loan_days = ?, retired = ? WHERE id = ?',
    [next.name, next.category, next.description, next.deposit_amount, next.late_fee_per_day, next.max_loan_days, next.retired, id]
  );
  return equipmentRowToApi(db.get('SELECT * FROM equipment WHERE id = ?', [id]));
}

function listUnits(equipmentId) {
  getEquipment(equipmentId);
  return db.all(
    'SELECT un.*, l.id AS loan_id, l.due_date, b.name AS borrower_name ' +
    'FROM units un ' +
    "LEFT JOIN loans l ON l.unit_id = un.id AND l.status = 'approved' " +
    'LEFT JOIN users b ON b.id = l.borrower_id ' +
    'WHERE un.equipment_id = ? ORDER BY un.created_at, un.label',
    [equipmentId]
  ).map(function (u) {
    return {
      id: u.id,
      equipmentId: u.equipment_id,
      label: u.label,
      status: u.status,
      loanId: u.loan_id || null,
      dueDate: u.due_date || null,
      borrowerName: u.borrower_name || null,
      overdue: !!(u.due_date && u.due_date < todayISO())
    };
  });
}

function addUnit(equipmentId, label) {
  const eq = getEquipment(equipmentId);
  const existing = db.get('SELECT COUNT(*) AS n FROM units WHERE equipment_id = ?', [equipmentId]);
  const finalLabel = String(label || '').trim() || (eq.name + ' #' + (existing.n + 1));
  const unit = { id: uid('un'), equipment_id: equipmentId, label: finalLabel, status: 'available', created_at: nowISO() };
  db.run('INSERT INTO units (id, equipment_id, label, status, created_at) VALUES (?, ?, ?, ?, ?)',
    [unit.id, unit.equipment_id, unit.label, unit.status, unit.created_at]);
  return { id: unit.id, equipmentId: equipmentId, label: unit.label, status: unit.status };
}

function toggleUnitMaintenance(unitId) {
  const unit = db.get('SELECT * FROM units WHERE id = ?', [unitId]);
  if (!unit) throw fail(404, 'Unit not found.');
  if (unit.status === 'borrowed') throw fail(400, 'This unit is out on loan — record the return first.');
  const next = unit.status === 'maintenance' ? 'available' : 'maintenance';
  db.run('UPDATE units SET status = ? WHERE id = ?', [next, unitId]);
  return { id: unit.id, equipmentId: unit.equipment_id, label: unit.label, status: next };
}

function deleteUnit(unitId) {
  const unit = db.get('SELECT * FROM units WHERE id = ?', [unitId]);
  if (!unit) throw fail(404, 'Unit not found.');
  if (unit.status === 'borrowed') throw fail(400, 'This unit is out on loan — record the return first.');
  const used = db.get('SELECT COUNT(*) AS n FROM loans WHERE unit_id = ?', [unitId]);
  if (used.n > 0) {
    db.run("UPDATE units SET status = 'maintenance', label = label || ' (retired)' WHERE id = ?", [unitId]);
    return { id: unitId, removed: false, retired: true };
  }
  db.run('DELETE FROM units WHERE id = ?', [unitId]);
  return { id: unitId, removed: true };
}

// ---------------------------------------------------------------
// Loans
// ---------------------------------------------------------------
const LOAN_SELECT =
  'SELECT l.*, e.name AS equipment_name, e.category AS equipment_category, ' +
  '       un.label AS unit_label, ' +
  '       b.name AS borrower_name, b.email AS borrower_email, ' +
  '       ob.name AS original_borrower_name ' +
  'FROM loans l ' +
  'JOIN equipment e ON e.id = l.equipment_id ' +
  'LEFT JOIN units un ON un.id = l.unit_id ' +
  'JOIN users b ON b.id = l.borrower_id ' +
  'JOIN users ob ON ob.id = l.original_borrower_id ';

function loanRowToApi(l) {
  const today = todayISO();
  const overdue = l.status === 'approved' && l.due_date < today;
  const daysLate = overdue ? daysBetween(l.due_date, today) : 0;
  return {
    id: l.id,
    equipmentId: l.equipment_id,
    equipmentName: l.equipment_name,
    equipmentCategory: l.equipment_category,
    unitId: l.unit_id,
    unitLabel: l.unit_label,
    borrowerId: l.borrower_id,
    borrowerName: l.borrower_name,
    borrowerEmail: l.borrower_email,
    originalBorrowerId: l.original_borrower_id,
    originalBorrowerName: l.original_borrower_name,
    note: l.note,
    status: l.status,
    requestedAt: l.requested_at,
    dueDate: l.due_date,
    approvedAt: l.approved_at,
    returnedAt: l.returned_at,
    depositAmount: l.deposit_amount,
    lateFeePerDay: l.late_fee_per_day,
    lateFeeCharged: l.late_fee_charged,
    depositRefunded: l.deposit_refunded,
    transferCount: l.transfer_count,
    lastNudgedAt: l.last_nudged_at,
    isOverdue: overdue,
    daysLate: daysLate,
    daysLeft: l.status === 'approved' ? daysBetween(today, l.due_date) : null,
    runningLateFee: daysLate * l.late_fee_per_day
  };
}

function getLoanRow(id) {
  const row = db.get(LOAN_SELECT + 'WHERE l.id = ?', [id]);
  if (!row) throw fail(404, 'Loan not found.');
  return row;
}

function getLoan(id) {
  return loanRowToApi(getLoanRow(id));
}

function activeLoanCount(userId, excludeLoanId) {
  const row = db.get(
    "SELECT COUNT(*) AS n FROM loans WHERE borrower_id = ? AND status IN ('pending','approved') AND id != ?",
    [userId, excludeLoanId || '']
  );
  return row.n;
}

function requestLoan(user, input) {
  if (user.role !== 'student') throw fail(403, 'Only student accounts can request gear.');
  const settings = getSettings();
  const eq = getEquipment(input.equipmentId);
  if (eq.retired === 1) throw fail(400, 'That item is no longer lent out.');

  const today = todayISO();
  const maxDue = addDaysISO(today, eq.max_loan_days);
  const dueDate = String(input.dueDate || maxDue).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw fail(400, 'Pick a valid return date.');
  if (dueDate <= today) throw fail(400, 'Pick a return date after today.');
  if (dueDate > maxDue) {
    throw fail(400, eq.name + ' goes out for at most ' + eq.max_loan_days + ' day(s) — return it by ' + maxDue + '.');
  }

  return db.transaction(function () {
    const used = activeLoanCount(user.id);
    if (used >= settings.maxActiveLoansPerBorrower) {
      throw fail(400, 'You already have ' + used + ' open request(s) or loan(s), which is the room limit of ' +
        settings.maxActiveLoansPerBorrower + '. Return something first.');
    }
    const free = db.get("SELECT COUNT(*) AS n FROM units WHERE equipment_id = ? AND status = 'available'", [eq.id]);
    const heldByRequests = db.get("SELECT COUNT(*) AS n FROM loans WHERE equipment_id = ? AND status = 'pending'", [eq.id]);
    if (free.n === 0) throw fail(400, 'No unit of this item is free right now.');
    if (heldByRequests.n >= free.n) {
      throw fail(400, 'Every free unit already has a request waiting at the desk. Try another date or item.');
    }

    const loan = {
      id: uid('ln'),
      equipment_id: eq.id,
      borrower_id: user.id,
      note: String(input.note || '').trim().slice(0, 300),
      status: 'pending',
      requested_at: nowISO(),
      due_date: dueDate,
      deposit_amount: eq.deposit_amount,
      late_fee_per_day: eq.late_fee_per_day
    };
    db.run(
      'INSERT INTO loans (id, equipment_id, unit_id, borrower_id, original_borrower_id, note, status, requested_at, due_date, deposit_amount, late_fee_per_day) ' +
      'VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
      [loan.id, loan.equipment_id, loan.borrower_id, loan.borrower_id, loan.note, loan.status,
        loan.requested_at, loan.due_date, loan.deposit_amount, loan.late_fee_per_day]
    );
    return loanRowToApi(getLoanRow(loan.id));
  });
}

function listLoansForUser(userId) {
  return db.all(LOAN_SELECT + 'WHERE l.borrower_id = ? ORDER BY l.requested_at DESC', [userId])
    .map(loanRowToApi);
}

function listLoans(filter) {
  const f = filter || {};
  let sql = LOAN_SELECT + 'WHERE 1 = 1 ';
  const params = [];
  if (f.status) { sql += 'AND l.status = ? '; params.push(f.status); }
  if (f.borrowerId) { sql += 'AND l.borrower_id = ? '; params.push(f.borrowerId); }
  if (f.overdue) { sql += "AND l.status = 'approved' AND l.due_date < ? "; params.push(todayISO()); }
  if (f.q) {
    sql += 'AND (lower(b.name) LIKE ? OR lower(b.email) LIKE ? OR lower(e.name) LIKE ?) ';
    const q = '%' + String(f.q).toLowerCase() + '%';
    params.push(q, q, q);
  }
  sql += 'ORDER BY CASE l.status WHEN \'approved\' THEN 0 WHEN \'pending\' THEN 1 ELSE 2 END, l.due_date, l.requested_at';
  return db.all(sql, params).map(loanRowToApi);
}

function approveLoan(loanId, staffUser) {
  return db.transaction(function () {
    const loan = getLoanRow(loanId);
    if (loan.status !== 'pending') throw fail(400, 'Only a waiting request can be approved.');

    const settings = getSettings();
    const used = activeLoanCount(loan.borrower_id, loan.id);
    if (used >= settings.maxActiveLoansPerBorrower) {
      throw fail(400, loan.borrower_name + ' is already at the ' + settings.maxActiveLoansPerBorrower + '-loan limit.');
    }

    const unit = db.get(
      "SELECT * FROM units WHERE equipment_id = ? AND status = 'available' ORDER BY created_at, label LIMIT 1",
      [loan.equipment_id]
    );
    if (!unit) throw fail(400, 'No free unit left to hand over.');

    db.run("UPDATE units SET status = 'borrowed' WHERE id = ?", [unit.id]);
    db.run(
      "UPDATE loans SET status = 'approved', unit_id = ?, approved_at = ?, approved_by = ? WHERE id = ?",
      [unit.id, nowISO(), staffUser.id, loanId]
    );
    return loanRowToApi(getLoanRow(loanId));
  });
}

function rejectLoan(loanId, staffUser, reason) {
  return db.transaction(function () {
    const loan = getLoanRow(loanId);
    if (loan.status !== 'pending') throw fail(400, 'Only a waiting request can be declined.');
    const note = String(reason || '').trim();
    db.run(
      "UPDATE loans SET status = 'rejected', approved_by = ?, approved_at = ?, note = ? WHERE id = ?",
      [staffUser.id, nowISO(), note ? (loan.note ? loan.note + ' · ' : '') + 'Declined: ' + note : loan.note, loanId]
    );
    return loanRowToApi(getLoanRow(loanId));
  });
}

function cancelLoan(loanId, user) {
  return db.transaction(function () {
    const loan = getLoanRow(loanId);
    if (loan.borrower_id !== user.id && user.role !== 'staff') throw fail(403, 'That request is not yours.');
    if (loan.status !== 'pending') throw fail(400, 'Only a request that is still waiting can be withdrawn.');
    db.run("UPDATE loans SET status = 'cancelled' WHERE id = ?", [loanId]);
    db.run("UPDATE loan_transfers SET status = 'cancelled', decided_at = ? WHERE loan_id = ? AND status = 'pending'",
      [nowISO(), loanId]);
    return loanRowToApi(getLoanRow(loanId));
  });
}

/**
 * Return: frees the unit, charges days-late x the item's per-day rate, and
 * refunds whatever is left of the deposit.
 */
function returnLoan(loanId, staffUser) {
  return db.transaction(function () {
    const loan = getLoanRow(loanId);
    if (loan.status !== 'approved') throw fail(400, 'Only an item that is out on loan can be returned.');

    const today = todayISO();
    const daysLate = loan.due_date < today ? daysBetween(loan.due_date, today) : 0;
    const lateFee = Math.round(daysLate * loan.late_fee_per_day * 100) / 100;
    const refund = Math.max(0, Math.round((loan.deposit_amount - lateFee) * 100) / 100);

    if (loan.unit_id) db.run("UPDATE units SET status = 'available' WHERE id = ?", [loan.unit_id]);
    db.run(
      "UPDATE loans SET status = 'returned', returned_at = ?, returned_by = ?, late_fee_charged = ?, deposit_refunded = ? WHERE id = ?",
      [nowISO(), staffUser.id, lateFee, refund, loanId]
    );
    db.run("UPDATE loan_transfers SET status = 'cancelled', decided_at = ? WHERE loan_id = ? AND status = 'pending'",
      [nowISO(), loanId]);
    return loanRowToApi(getLoanRow(loanId));
  });
}

function nudgeLoan(loanId) {
  const loan = getLoanRow(loanId);
  if (loan.status !== 'approved') throw fail(400, 'Only an item still out can be chased up.');
  db.run('UPDATE loans SET last_nudged_at = ? WHERE id = ?', [nowISO(), loanId]);
  const api = loanRowToApi(getLoanRow(loanId));
  const line = api.isOverdue
    ? 'is ' + api.daysLate + ' day(s) overdue. Late fee so far: ' + api.runningLateFee + '.'
    : 'is due back on ' + api.dueDate + '.';
  return {
    loan: api,
    reminder: {
      to: api.borrowerEmail,
      subject: 'AV room: ' + api.equipmentName + (api.isOverdue ? ' is overdue' : ' is due back soon'),
      body: 'Hi ' + api.borrowerName + ',\n\n' +
        (api.unitLabel || api.equipmentName) + ' ' + line + '\n' +
        'Please drop it back at the AV room desk so the next person can book it.\n\n' +
        'Thanks,\nAV Room desk'
    }
  };
}

// ---------------------------------------------------------------
// Transfers — hand an active loan to another borrower
// ---------------------------------------------------------------
const TRANSFER_SELECT =
  'SELECT t.*, l.due_date, l.status AS loan_status, l.unit_id, ' +
  '       e.name AS equipment_name, un.label AS unit_label, ' +
  '       fu.name AS from_name, fu.email AS from_email, ' +
  '       tu.name AS to_name, tu.email AS to_email ' +
  'FROM loan_transfers t ' +
  'JOIN loans l ON l.id = t.loan_id ' +
  'JOIN equipment e ON e.id = l.equipment_id ' +
  'LEFT JOIN units un ON un.id = l.unit_id ' +
  'JOIN users fu ON fu.id = t.from_user_id ' +
  'JOIN users tu ON tu.id = t.to_user_id ';

function transferRowToApi(t) {
  return {
    id: t.id,
    loanId: t.loan_id,
    equipmentName: t.equipment_name,
    unitLabel: t.unit_label,
    fromUserId: t.from_user_id,
    fromName: t.from_name,
    fromEmail: t.from_email,
    toUserId: t.to_user_id,
    toName: t.to_name,
    toEmail: t.to_email,
    dueDate: t.due_date_at_transfer,
    loanDueDate: t.due_date,
    loanStatus: t.loan_status,
    status: t.status,
    initiatedBy: t.initiated_by,
    initiatedRole: t.initiated_role,
    note: t.note,
    createdAt: t.created_at,
    decidedAt: t.decided_at
  };
}

function getTransferRow(id) {
  const row = db.get(TRANSFER_SELECT + 'WHERE t.id = ?', [id]);
  if (!row) throw fail(404, 'Handover not found.');
  return row;
}

/**
 * Moves the loan to a new borrower.
 *
 * Deliberately untouched: `due_date` (the clock does not restart) and
 * `unit_id` / the unit's `borrowed` status (the item never goes back into the
 * pool, so the catalog count does not move). Only who owes it changes.
 */
function applyTransfer(transferRow, decidedBy) {
  const loan = getLoanRow(transferRow.loan_id);
  if (loan.status !== 'approved') throw fail(400, 'Only an item currently out on loan can be handed over.');
  if (loan.borrower_id !== transferRow.from_user_id) {
    throw fail(409, 'This loan has already moved to someone else — start a fresh handover.');
  }
  const recipient = getUserById(transferRow.to_user_id);
  if (!recipient || recipient.role !== 'student' || recipient.active !== 1) {
    throw fail(400, 'That account can no longer take a loan.');
  }

  const settings = getSettings();
  const used = activeLoanCount(recipient.id, loan.id);
  if (used >= settings.maxActiveLoansPerBorrower) {
    throw fail(400, recipient.name + ' is already at the ' + settings.maxActiveLoansPerBorrower + '-loan limit.');
  }

  const dueBefore = loan.due_date;
  const unitBefore = loan.unit_id;

  db.run('UPDATE loans SET borrower_id = ?, transfer_count = transfer_count + 1 WHERE id = ?',
    [recipient.id, loan.id]);
  db.run("UPDATE loan_transfers SET status = 'completed', decided_at = ?, decided_by = ? WHERE id = ?",
    [nowISO(), decidedBy.id, transferRow.id]);
  // Any other handover still waiting on this loan is now stale.
  db.run("UPDATE loan_transfers SET status = 'cancelled', decided_at = ? WHERE loan_id = ? AND status = 'pending' AND id != ?",
    [nowISO(), loan.id, transferRow.id]);

  const after = getLoanRow(loan.id);
  if (after.due_date !== dueBefore || after.unit_id !== unitBefore || after.status !== 'approved') {
    throw fail(500, 'Handover aborted: it would have changed the due date or the item availability.');
  }
  return { loan: loanRowToApi(after), transfer: transferRowToApi(getTransferRow(transferRow.id)) };
}

/**
 * A student hands over to someone else: the other person has to accept, since
 * they are taking on the due date, the deposit and the late fee.
 * A staff member doing it at the desk records a handover that is already done.
 */
function startTransfer(actor, loanId, input) {
  const settings = getSettings();
  return db.transaction(function () {
    const loan = getLoanRow(loanId);
    if (loan.status !== 'approved') throw fail(400, 'Only an item currently out on loan can be handed over.');
    if (actor.role !== 'staff') {
      if (!settings.allowStudentTransfers) throw fail(403, 'Handovers have to be done at the AV desk right now.');
      if (loan.borrower_id !== actor.id) throw fail(403, 'That loan is not yours to hand over.');
    }

    const recipient = input.toUserId
      ? getUserById(input.toUserId)
      : getUserByEmail(input.toEmail, 'student');
    if (!recipient || recipient.role !== 'student') {
      throw fail(404, 'No student account with that email. They need to register on the catalog page first.');
    }
    if (recipient.active !== 1) throw fail(400, 'That account has been switched off.');
    if (recipient.id === loan.borrower_id) throw fail(400, 'That loan is already in their name.');

    const existing = db.get(
      "SELECT id FROM loan_transfers WHERE loan_id = ? AND status = 'pending'", [loanId]
    );
    if (existing) throw fail(409, 'A handover for this loan is already waiting to be accepted.');

    const used = activeLoanCount(recipient.id, loan.id);
    if (used >= settings.maxActiveLoansPerBorrower) {
      throw fail(400, recipient.name + ' is already at the ' + settings.maxActiveLoansPerBorrower + '-loan limit.');
    }

    const row = {
      id: uid('tr'),
      loan_id: loanId,
      from_user_id: loan.borrower_id,
      to_user_id: recipient.id,
      due_date_at_transfer: loan.due_date,
      status: actor.role === 'staff' ? 'pending' : 'pending',
      initiated_by: actor.id,
      initiated_role: actor.role,
      note: String(input.note || '').trim().slice(0, 300),
      created_at: nowISO()
    };
    db.run(
      'INSERT INTO loan_transfers (id, loan_id, from_user_id, to_user_id, due_date_at_transfer, status, initiated_by, initiated_role, note, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.loan_id, row.from_user_id, row.to_user_id, row.due_date_at_transfer, row.status,
        row.initiated_by, row.initiated_role, row.note, row.created_at]
    );

    // Staff are standing at the desk watching the item change hands, so their
    // handover goes through straight away.
    if (actor.role === 'staff') {
      return applyTransfer(getTransferRow(row.id), actor);
    }
    return { loan: loanRowToApi(getLoanRow(loanId)), transfer: transferRowToApi(getTransferRow(row.id)) };
  });
}

function acceptTransfer(transferId, user) {
  return db.transaction(function () {
    const t = getTransferRow(transferId);
    if (t.status !== 'pending') throw fail(400, 'This handover has already been dealt with.');
    if (t.to_user_id !== user.id) throw fail(403, 'This handover was not sent to you.');
    return applyTransfer(t, user);
  });
}

function rejectTransfer(transferId, user) {
  return db.transaction(function () {
    const t = getTransferRow(transferId);
    if (t.status !== 'pending') throw fail(400, 'This handover has already been dealt with.');
    if (t.to_user_id !== user.id && user.role !== 'staff') throw fail(403, 'This handover was not sent to you.');
    db.run("UPDATE loan_transfers SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?",
      [nowISO(), user.id, transferId]);
    return transferRowToApi(getTransferRow(transferId));
  });
}

function cancelTransfer(transferId, user) {
  return db.transaction(function () {
    const t = getTransferRow(transferId);
    if (t.status !== 'pending') throw fail(400, 'This handover has already been dealt with.');
    if (t.from_user_id !== user.id && user.role !== 'staff') throw fail(403, 'That handover is not yours to withdraw.');
    db.run("UPDATE loan_transfers SET status = 'cancelled', decided_at = ?, decided_by = ? WHERE id = ?",
      [nowISO(), user.id, transferId]);
    return transferRowToApi(getTransferRow(transferId));
  });
}

function listTransfers(filter) {
  const f = filter || {};
  let sql = TRANSFER_SELECT + 'WHERE 1 = 1 ';
  const params = [];
  if (f.status) { sql += 'AND t.status = ? '; params.push(f.status); }
  if (f.loanId) { sql += 'AND t.loan_id = ? '; params.push(f.loanId); }
  if (f.userId) { sql += 'AND (t.from_user_id = ? OR t.to_user_id = ?) '; params.push(f.userId, f.userId); }
  sql += 'ORDER BY t.created_at DESC LIMIT 200';
  return db.all(sql, params).map(transferRowToApi);
}

// ---------------------------------------------------------------
// Desk summary
// ---------------------------------------------------------------
function deskStats() {
  const today = todayISO();
  const one = function (sql, params) { return db.get(sql, params).n; };
  return {
    pendingRequests: one("SELECT COUNT(*) AS n FROM loans WHERE status = 'pending'"),
    outNow: one("SELECT COUNT(*) AS n FROM loans WHERE status = 'approved'"),
    overdue: one("SELECT COUNT(*) AS n FROM loans WHERE status = 'approved' AND due_date < ?", [today]),
    dueToday: one("SELECT COUNT(*) AS n FROM loans WHERE status = 'approved' AND due_date = ?", [today]),
    pendingTransfers: one("SELECT COUNT(*) AS n FROM loan_transfers WHERE status = 'pending'"),
    unitsFree: one("SELECT COUNT(*) AS n FROM units WHERE status = 'available'"),
    unitsTotal: one('SELECT COUNT(*) AS n FROM units'),
    feesCollected: db.get("SELECT COALESCE(SUM(late_fee_charged), 0) AS n FROM loans WHERE status = 'returned'").n
  };
}

// ---------------------------------------------------------------
// First-run seed
// ---------------------------------------------------------------
function seed() {
  const staffCount = db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'staff'").n;
  if (staffCount === 0) {
    createUser({ name: 'AV Room Staff', email: 'staff@avroom.local', password: 'admin123', role: 'staff' });
  }
  Object.keys(SETTING_DEFAULTS).forEach(function (k) {
    const existing = db.get('SELECT value FROM settings WHERE key = ?', [k]);
    if (!existing) setSetting(k, SETTING_DEFAULTS[k]);
  });
  const eqCount = db.get('SELECT COUNT(*) AS n FROM equipment').n;
  if (eqCount === 0) {
    [
      { name: 'Canon DSLR kit', category: 'Camera', description: 'Canon body, 18-55mm lens, spare battery, 32GB card.', depositAmount: 3000, lateFeePerDay: 100, maxLoanDays: 3, unitCount: 3 },
      { name: 'Epson projector', category: 'Projector', description: 'HDMI and VGA in, remote and 5m cable included.', depositAmount: 2000, lateFeePerDay: 80, maxLoanDays: 2, unitCount: 2 },
      { name: 'Rode shotgun mic', category: 'Audio', description: 'Camera-mount shotgun mic with windshield and cable.', depositAmount: 800, lateFeePerDay: 40, maxLoanDays: 3, unitCount: 4 },
      { name: 'Manfrotto tripod', category: 'Support', description: 'Fluid head, holds up to 5kg, quick-release plate.', depositAmount: 500, lateFeePerDay: 20, maxLoanDays: 3, unitCount: 5 },
      { name: 'LED panel light', category: 'Lighting', description: 'Bi-colour LED panel, stand and V-mount battery.', depositAmount: 1200, lateFeePerDay: 50, maxLoanDays: 2, unitCount: 2 },
      { name: 'Wireless lapel mic set', category: 'Audio', description: 'Two transmitters, one receiver, spare AA cells.', depositAmount: 1500, lateFeePerDay: 60, maxLoanDays: 3, unitCount: 2 }
    ].forEach(createEquipment);
  }
}

module.exports = {
  fail,
  getSettings, updateSettings,
  publicUser, createUser, authenticate, getUserById, getUserByEmail, listUsers, searchStudents,
  setStaffActive, changePassword,
  listEquipment, getEquipment, createEquipment, updateEquipment,
  listUnits, addUnit, toggleUnitMaintenance, deleteUnit,
  requestLoan, listLoansForUser, listLoans, getLoan, approveLoan, rejectLoan, cancelLoan, returnLoan, nudgeLoan,
  startTransfer, acceptTransfer, rejectTransfer, cancelTransfer, listTransfers,
  deskStats, seed
};
