// Tiny file-backed JSON "database". No native dependencies, so it installs
// cleanly on GitHub Codespaces with a plain `npm install`. Fine for a
// single-instance demo/college-project deployment; swap for a real database
// later if this needs to scale or run multiple server instances.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

function ensureFile() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      users: [],
      equipment: [],
      units: [],
      loans: [],
      settings: { maxActiveLoansPerBorrower: 3, defaultLoanDays: 7 }
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
  }
}
ensureFile();

function readDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(aISO, bISO) {
  const a = new Date(aISO + 'T00:00:00');
  const b = new Date(bISO + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

module.exports = { readDB, writeDB, uid, todayISO, addDaysISO, daysBetween };
