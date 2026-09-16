'use strict';

/**
 * Fills the database with a believable afternoon at the AV desk:
 * a few students, an approved loan, something overdue, a request waiting,
 * and a handover sitting with the person it was sent to.
 *
 *   npm run demo
 *
 * Safe to run on a fresh database. Run `npm run reset` first if you want to
 * start clean.
 */

const store = require('../store');
const db = require('../db');

store.seed();

function student(name, email) {
  const existing = store.getUserByEmail(email, 'student');
  if (existing) return store.publicUser(existing);
  return store.createUser({ name: name, email: email, password: 'student123' });
}

const asha = student('Asha Verma', 'asha@college.edu');
const ravi = student('Ravi Nair', 'ravi@college.edu');
const meera = student('Meera Joshi', 'meera@college.edu');
const dev = student('Dev Patel', 'dev@college.edu');

const staff = store.publicUser(store.getUserByEmail('staff@avroom.local', 'staff'));
const catalog = store.listEquipment();
const find = function (part) {
  const hit = catalog.find(function (e) { return e.name.toLowerCase().indexOf(part.toLowerCase()) >= 0; });
  if (!hit) throw new Error('Seed catalog is missing "' + part + '"');
  return hit;
};

const today = db.todayISO();

// 1. Asha has a camera out, due in two days.
const l1 = store.requestLoan(asha, { equipmentId: find('Canon').id, dueDate: db.addDaysISO(today, 2), note: 'Film club shoot' });
store.approveLoan(l1.id, staff);

// 2. Ravi kept the projector too long — four days overdue.
const l2 = store.requestLoan(ravi, { equipmentId: find('Epson').id, dueDate: db.addDaysISO(today, 1), note: 'Seminar in B-block' });
store.approveLoan(l2.id, staff);
db.run('UPDATE loans SET due_date = ? WHERE id = ?', [db.addDaysISO(today, -4), l2.id]);

// 3. Meera is waiting on approval for a mic.
store.requestLoan(meera, { equipmentId: find('Rode').id, dueDate: db.addDaysISO(today, 2), note: 'Podcast recording' });

// 4. A tripod that has already changed hands once, at the desk.
const l4 = store.requestLoan(dev, { equipmentId: find('Manfrotto').id, dueDate: db.addDaysISO(today, 3) });
store.approveLoan(l4.id, staff);
store.startTransfer(staff, l4.id, { toEmail: meera.email, note: 'Swapped at the desk after the shoot' });

// 5. Asha is trying to pass the camera to Ravi — waiting for him to accept.
store.startTransfer(asha, l1.id, { toEmail: ravi.email, note: 'You shoot on Sunday, I am done with it' });

// 6. One returned loan, handed back two days late, so the ledger is not empty.
const l6 = store.requestLoan(dev, { equipmentId: find('LED').id, dueDate: db.addDaysISO(today, 1) });
store.approveLoan(l6.id, staff);
db.run('UPDATE loans SET due_date = ? WHERE id = ?', [db.addDaysISO(today, -2), l6.id]);
store.returnLoan(l6.id, staff);

// 7. One unit off for repair.
const micUnits = store.listUnits(find('Rode').id);
store.toggleUnitMaintenance(micUnits[micUnits.length - 1].id);

console.log('Demo data loaded.\n');
console.log('Students (password: student123)');
[asha, ravi, meera, dev].forEach(function (s) { console.log('  ' + s.email + '  — ' + s.name); });
console.log('\nStaff: staff@avroom.local / admin123');
console.log('\nOn the desk right now: ' + JSON.stringify(store.deskStats(), null, 2));
console.log('\nTry: log in as ravi@college.edu and accept the camera handover on the Handovers tab —');
console.log('the return date stays put and the catalog count does not move.');
