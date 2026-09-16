'use strict';

/**
 * Deletes the database file so the next start seeds a fresh room.
 *   npm run reset
 */

const fs = require('fs');
const path = require('path');

const file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'avroom.db');
let removed = 0;

['', '-wal', '-shm'].forEach(function (suffix) {
  try {
    fs.unlinkSync(file + suffix);
    removed++;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
});

console.log(removed ? 'Database cleared: ' + file : 'Nothing to clear at ' + file);
console.log('Start the server with `npm start` to seed the catalog and the default staff login again.');
