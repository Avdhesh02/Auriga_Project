'use strict';

/**
 * The room's rules, checked end to end against a throwaway database.
 *
 *   npm test
 *
 * The important ones are the two in capitals: a handover must not move the
 * due date, and must not change what the catalog says is free.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_PATH = path.join(os.tmpdir(), 'avroom-test.db');
['', '-wal', '-shm'].forEach(s => { try { fs.unlinkSync(process.env.DB_PATH + s); } catch (e) {} });

const store = require('../store');
const db = require('../db');

let pass = 0, failn = 0;
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { failn++; console.log('  FAIL ' + label + (extra ? ' -> ' + extra : '')); }
}
function throws(label, fn, match) {
  try { fn(); check(label + ' (should throw)', false, 'no error'); }
  catch (e) { check(label + ' [' + e.message + ']', !match || e.message.indexOf(match) >= 0, e.message); }
}

store.seed();
console.log('Running against ' + db.file + ' (driver: ' + db.driver + ')\n');

// --- users
const asha = store.createUser({ name: 'Asha', email: 'asha@clg.edu', password: 'secret1' });
const ravi = store.createUser({ name: 'Ravi', email: 'ravi@clg.edu', password: 'secret1' });
const meera = store.createUser({ name: 'Meera', email: 'meera@clg.edu', password: 'secret1' });
const staff = store.authenticate('staff@avroom.local', 'admin123', 'staff');
check('staff seeded', !!staff);
throws('duplicate email', () => store.createUser({ name: 'X', email: 'ASHA@clg.edu', password: 'secret1' }), 'already exists');
throws('bad password', () => store.authenticate('asha@clg.edu', 'nope', 'student'), 'Incorrect');
throws('student cannot use staff door', () => store.authenticate('asha@clg.edu', 'secret1', 'staff'));

// --- catalog
const cat = store.listEquipment();
const dslr = cat.find(e => e.name.indexOf('Canon') === 0);
check('seed catalog', cat.length === 6 && dslr.totalUnits === 3 && dslr.availableUnits === 3);

// --- request + approve
const loan1 = store.requestLoan(asha, { equipmentId: dslr.id, dueDate: db.addDaysISO(db.todayISO(), 2), note: 'film club' });
check('request pending', loan1.status === 'pending' && loan1.unitId === null);
check('availability unchanged while pending', store.listEquipment().find(e => e.id === dslr.id).availableUnits === 3);
throws('due date beyond max', () => store.requestLoan(ravi, { equipmentId: dslr.id, dueDate: db.addDaysISO(db.todayISO(), 30) }), 'at most');
throws('due date in past', () => store.requestLoan(ravi, { equipmentId: dslr.id, dueDate: '2020-01-01' }), 'after today');

const appr1 = store.approveLoan(loan1.id, staff);
check('approved gets a unit', appr1.status === 'approved' && !!appr1.unitId && !!appr1.unitLabel);
check('one unit left the pool', store.listEquipment().find(e => e.id === dslr.id).availableUnits === 2);

// --- per-borrower limit (default 3)
const tripod = cat.find(e => e.name.indexOf('Manfrotto') === 0);
const mic = cat.find(e => e.name.indexOf('Rode') === 0);
const led = cat.find(e => e.name.indexOf('LED') === 0);
store.requestLoan(asha, { equipmentId: tripod.id });
store.requestLoan(asha, { equipmentId: mic.id });
throws('limit of 3 enforced', () => store.requestLoan(asha, { equipmentId: led.id }), 'room limit');

// --- transfer twist
const before = store.listEquipment().find(e => e.id === dslr.id);
const started = store.startTransfer(asha, appr1.id, { toEmail: 'ravi@clg.edu', note: 'Ravi shoots Sunday' });
check('handover waits for the other person', started.transfer.status === 'pending');
check('loan still with Asha until accepted', store.getLoan(appr1.id).borrowerId === asha.id);
throws('no duplicate pending handover', () => store.startTransfer(asha, appr1.id, { toEmail: 'meera@clg.edu' }), 'already waiting');
throws('wrong person cannot accept', () => store.acceptTransfer(started.transfer.id, meera), 'not sent to you');

const done = store.acceptTransfer(started.transfer.id, ravi);
const after = store.listEquipment().find(e => e.id === dslr.id);
check('borrower changed', done.loan.borrowerId === ravi.id && done.loan.borrowerName === 'Ravi');
check('DUE DATE CARRIES OVER', done.loan.dueDate === appr1.dueDate, done.loan.dueDate + ' vs ' + appr1.dueDate);
check('same physical unit', done.loan.unitId === appr1.unitId);
check('AVAILABILITY UNAFFECTED', after.availableUnits === before.availableUnits && after.borrowedUnits === before.borrowedUnits);
check('transfer counted', done.loan.transferCount === 1);
check('original borrower remembered', done.loan.originalBorrowerName === 'Asha');
check('Asha freed a slot', store.listLoansForUser(asha.id).filter(l => l.status === 'approved' || l.status === 'pending').length === 2);
check('Ravi now holds it', store.listLoansForUser(ravi.id)[0].id === appr1.id);
throws('cannot hand over a loan you no longer hold', () => store.startTransfer(asha, appr1.id, { toEmail: 'meera@clg.edu' }), 'not yours');

// chain transfer: Ravi -> Meera
const chain = store.startTransfer(ravi, appr1.id, { toEmail: 'meera@clg.edu' });
const chained = store.acceptTransfer(chain.transfer.id, meera);
check('chained handover keeps due date', chained.loan.dueDate === appr1.dueDate && chained.loan.transferCount === 2);
check('history has both hops', store.listTransfers({ loanId: appr1.id }).filter(t => t.status === 'completed').length === 2);

// staff desk handover is immediate
const direct = store.startTransfer(staff, appr1.id, { toEmail: 'asha@clg.edu', note: 'swapped at desk' });
check('staff handover applies at once', direct.transfer.status === 'completed' && direct.loan.borrowerId === asha.id);
check('still same due date', direct.loan.dueDate === appr1.dueDate);

// recipient at the limit is refused
store.requestLoan(ravi, { equipmentId: led.id });
store.requestLoan(ravi, { equipmentId: cat.find(e => e.name.indexOf('Epson') === 0).id });
store.requestLoan(ravi, { equipmentId: cat.find(e => e.name.indexOf('Wireless') === 0).id });
throws('recipient over limit refused', () => store.startTransfer(staff, appr1.id, { toEmail: 'ravi@clg.edu' }), 'limit');

// --- overdue + return + late fee
db.run("UPDATE loans SET due_date = ? WHERE id = ?", [db.addDaysISO(db.todayISO(), -3), appr1.id]);
const over = store.getLoan(appr1.id);
check('overdue flagged', over.isOverdue && over.daysLate === 3 && over.runningLateFee === 300);
const nudge = store.nudgeLoan(appr1.id);
check('nudge builds a reminder', nudge.reminder.body.indexOf('overdue') > 0 && !!nudge.loan.lastNudgedAt);
const returned = store.returnLoan(appr1.id, staff);
check('late fee = 3 x 100', returned.lateFeeCharged === 300);
check('deposit refund = 3000 - 300', returned.depositRefunded === 2700);
check('unit back in the pool', store.listEquipment().find(e => e.id === dslr.id).availableUnits === before.availableUnits + 1);
throws('cannot hand over a returned loan', () => store.startTransfer(staff, appr1.id, { toEmail: 'meera@clg.edu' }), 'currently out');
throws('cannot return twice', () => store.returnLoan(appr1.id, staff), 'out on loan');

// --- maintenance pulls a unit out of the pool
const units = store.listUnits(tripod.id);
const freeUnit = units.find(u => u.status === 'available');
store.toggleUnitMaintenance(freeUnit.id);
check('maintenance removes availability', store.listEquipment().find(e => e.id === tripod.id).maintenanceUnits === 1);
store.toggleUnitMaintenance(freeUnit.id);

// --- nextFreeDate answers "is one free this weekend?"
const proj = store.listEquipment().find(e => e.name.indexOf('Epson') === 0);
check('nextFreeDate present', !!proj.nextFreeDate);

// --- settings
const s = store.updateSettings({ maxActiveLoansPerBorrower: 4, defaultLoanDays: 5, allowStudentTransfers: false });
check('settings saved', s.maxActiveLoansPerBorrower === 4 && s.allowStudentTransfers === false);

const mLoan = store.requestLoan(meera, { equipmentId: tripod.id });
store.approveLoan(mLoan.id, staff);
throws('students blocked when the desk turns handovers off',
  () => store.startTransfer(meera, mLoan.id, { toEmail: 'asha@clg.edu' }), 'AV desk');
check('the desk can still do it by hand',
  store.startTransfer(staff, mLoan.id, { toEmail: 'asha@clg.edu' }).transfer.status === 'completed');
store.updateSettings({ allowStudentTransfers: true, maxActiveLoansPerBorrower: 3 });

console.log('\nstats:', JSON.stringify(store.deskStats()));
console.log('\n' + pass + ' passed, ' + failn + ' failed');
process.exit(failn ? 1 : 0);
