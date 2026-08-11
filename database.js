const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

db.serialize(() => {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      userId TEXT PRIMARY KEY,
      balance INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Transactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      txnId TEXT PRIMARY KEY,
      userId TEXT,
      planId TEXT,
      amount INTEGER,
      searches INTEGER,
      status TEXT DEFAULT 'PENDING',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;
