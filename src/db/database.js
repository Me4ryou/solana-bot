// src/db/database.js
// Sets up SQLite database and creates all tables on first run

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/kol_tracker.db');

// Make sure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// ─── CREATE TABLES ───────────────────────────────────────────────────────────

db.exec(`
  -- Tracked KOL wallets
  CREATE TABLE IF NOT EXISTS wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'smart_money',
    -- Types: sniper, influencer, smart_money, high_information, copy_trader
    quality_score INTEGER NOT NULL DEFAULT 5,
    -- Score 1-10, higher = more trusted
    is_active INTEGER NOT NULL DEFAULT 1,
    -- 1 = tracking, 0 = paused
    helius_webhook_id TEXT,
    -- Helius webhook ID for this wallet
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_signals INTEGER DEFAULT 0,
    successful_signals INTEGER DEFAULT 0
  );

  -- Every buy event detected from tracked wallets
  CREATE TABLE IF NOT EXISTS buy_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    sol_spent REAL,
    token_amount REAL,
    tx_signature TEXT UNIQUE NOT NULL,
    timestamp DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Active convergence windows per token
  CREATE TABLE IF NOT EXISTS convergence_windows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    token_name TEXT,
    first_buy_at DATETIME NOT NULL,
    last_buy_at DATETIME,
    wallet_count INTEGER DEFAULT 1,
    total_sol_spent REAL DEFAULT 0,
    confidence_score REAL DEFAULT 0,
    velocity_score REAL DEFAULT 0,
    convergence_type TEXT,
    -- organic, fast_momentum, clustered_activity
    is_active INTEGER DEFAULT 1,
    alert_sent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Alerts that have been sent
  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    confidence_score REAL,
    wallet_count INTEGER,
    convergence_type TEXT,
    alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    cooldown_until DATETIME
    -- No new alert for this token until this time
  );

  -- Exit events (sells from tracked wallets)
  CREATE TABLE IF NOT EXISTS exit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_symbol TEXT,
    percent_sold REAL,
    -- Estimated % of position sold
    tx_signature TEXT UNIQUE NOT NULL,
    timestamp DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Token metadata cache
  CREATE TABLE IF NOT EXISTS token_cache (
    token_mint TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    liquidity_usd REAL,
    market_cap REAL,
    price_usd REAL,
    created_at_chain DATETIME,
    is_trending INTEGER DEFAULT 0,
    mint_authority TEXT,
    freeze_authority TEXT,
    trust_score REAL,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ─── INDEXES FOR FAST QUERIES ─────────────────────────────────────────────────

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_buy_events_token ON buy_events(token_mint);
  CREATE INDEX IF NOT EXISTS idx_buy_events_wallet ON buy_events(wallet_address);
  CREATE INDEX IF NOT EXISTS idx_buy_events_timestamp ON buy_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_convergence_token ON convergence_windows(token_mint);
  CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(token_mint);
`);

console.log('✅ Database initialized at', DB_PATH);

module.exports = db;
