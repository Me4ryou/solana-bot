// src/index.js
// Main entry point — wires together Express server, Telegram bot, and Helius webhooks

require('dotenv').config();
const express = require('express');
const bot = require('./bot/bot');
const { router: webhookRouter } = require('./webhook/listener');
const { registerWalletWebhook, getRegisteredWebhooks } = require('./utils/webhookManager');
const db = require('./db/database');
const { sendMessage } = require('./alerts/sender');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────────────────────────────
// Health check — Railway uses this to verify service is running
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'KOL Convergence Tracker',
    uptime: Math.floor(process.uptime()) + 's',
    trackedWallets: db.prepare('SELECT COUNT(*) as c FROM wallets WHERE is_active = 1').get().c,
    totalSignals: db.prepare('SELECT COUNT(*) as c FROM alerts').get().c,
  });
});

// Helius webhook endpoint
app.use('/webhook', webhookRouter);

// ─── START SERVER ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🚀 KOL Tracker running on port ${PORT}`);
  console.log(`📡 Webhook URL: ${process.env.WEBHOOK_URL}/webhook/helius`);

  // Start Telegram bot
  await startBot();

  // Auto-register webhooks for all active wallets
  await syncHeliusWebhooks();

  // Notify admin on startup
  await sendMessage(`🟢 *KOL Tracker Online*\n\nService started successfully.\nTracking ${db.prepare('SELECT COUNT(*) as c FROM wallets WHERE is_active = 1').get().c} wallets.`);
});

// ─── START TELEGRAM BOT ───────────────────────────────────────────────────────
async function startBot() {
  try {
    bot.launch();
    console.log('✅ Telegram bot started');

    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (err) {
    console.error('❌ Failed to start Telegram bot:', err.message);
  }
}

// ─── SYNC HELIUS WEBHOOKS ─────────────────────────────────────────────────────
// On every startup, make sure all active wallets have Helius webhooks registered
async function syncHeliusWebhooks() {
  try {
    const wallets = db.prepare('SELECT * FROM wallets WHERE is_active = 1').all();

    if (wallets.length === 0) {
      console.log('⚠️ No wallets to sync — add wallets via Telegram bot');
      return;
    }

    console.log(`\n🔄 Syncing ${wallets.length} wallet(s) with Helius...`);

    let registered = 0;
    let skipped = 0;

    for (const wallet of wallets) {
      // Only register if not already registered
      if (!wallet.helius_webhook_id) {
        const webhookId = await registerWalletWebhook(wallet.address);
        if (webhookId) {
          registered++;
        }
      } else {
        skipped++;
      }
      // Small delay to avoid hammering Helius API
      await sleep(300);
    }

    console.log(`✅ Webhook sync complete — ${registered} registered, ${skipped} already active\n`);

  } catch (err) {
    console.error('❌ Failed to sync Helius webhooks:', err.message);
  }
}

// ─── CLEANUP OLD DATA ─────────────────────────────────────────────────────────
// Run every hour — removes expired convergence windows and old buy events
setInterval(() => {
  try {
    // Remove buy events older than 24 hours (keep recent history)
    const deletedEvents = db.prepare(`
      DELETE FROM buy_events 
      WHERE timestamp < datetime('now', '-24 hours')
    `).run();

    // Remove expired convergence windows
    const deletedWindows = db.prepare(`
      DELETE FROM convergence_windows
      WHERE is_active = 0 
      AND created_at < datetime('now', '-48 hours')
    `).run();

    // Clear old token cache
    const deletedCache = db.prepare(`
      DELETE FROM token_cache
      WHERE last_updated < datetime('now', '-1 hour')
    `).run();

    if (deletedEvents.changes > 0 || deletedWindows.changes > 0) {
      console.log(`🧹 Cleanup: removed ${deletedEvents.changes} events, ${deletedWindows.changes} windows, ${deletedCache.changes} cache entries`);
    }
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
  }
}, 60 * 60 * 1000); // Every hour

// ─── HELPER ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── HANDLE UNCAUGHT ERRORS ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled Rejection:', reason);
});
