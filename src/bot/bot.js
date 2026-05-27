// src/bot/bot.js
// Telegram bot with persistent menu buttons and wallet management

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('../db/database');
const { registerWalletWebhook, removeWalletWebhook } = require('../utils/webhookManager');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── SECURITY: Only allow admin ───────────────────────────────────────────────
bot.use((ctx, next) => {
  const chatId = ctx.chat?.id?.toString();
  if (chatId !== ADMIN_CHAT_ID) {
    return ctx.reply('⛔ Unauthorized.');
  }
  return next();
});

// ─── SESSION: Track what step user is on ─────────────────────────────────────
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = {};
  return sessions[chatId];
}

// ─── MAIN MENU ────────────────────────────────────────────────────────────────
const mainMenu = Markup.keyboard([
  ['➕ Add Wallet', '📋 My Wallets'],
  ['❌ Remove Wallet', '⏸ Pause Wallet'],
  ['📊 Status', '⚙️ Settings'],
]).resize();

// ─── START ────────────────────────────────────────────────────────────────────
bot.start((ctx) => {
  ctx.reply(
    `👁 *KOL Convergence Tracker*\n\nMonitoring smart money on Solana.\nUse the menu below to manage wallets and settings.`,
    {
      parse_mode: 'Markdown',
      ...mainMenu,
    }
  );
});

// ─── STATUS ───────────────────────────────────────────────────────────────────
bot.hears('📊 Status', (ctx) => {
  const wallets = db.prepare('SELECT * FROM wallets WHERE is_active = 1').all();
  const totalWallets = db.prepare('SELECT COUNT(*) as count FROM wallets').get();
  const totalSignals = db.prepare('SELECT COUNT(*) as count FROM alerts').get();
  const recentSignals = db
    .prepare(
      `SELECT COUNT(*) as count FROM alerts 
       WHERE alerted_at > datetime('now', '-24 hours')`
    )
    .get();

  let msg = `📊 *Tracker Status*\n\n`;
  msg += `🟢 Active Wallets: ${wallets.length}\n`;
  msg += `📁 Total Wallets: ${totalWallets.count}\n`;
  msg += `🚨 Total Signals: ${totalSignals.count}\n`;
  msg += `📈 Signals (24h): ${recentSignals.count}\n\n`;
  msg += `⚙️ Settings:\n`;
  msg += `• Min Wallets: ${process.env.MIN_WALLETS}\n`;
  msg += `• Time Window: ${process.env.TIME_WINDOW_HOURS}hrs\n`;
  msg += `• Cooldown: ${process.env.COOLDOWN_HOURS}hrs\n`;
  msg += `• Min Confidence: ${process.env.MIN_CONFIDENCE}/100\n`;
  msg += `• Min Liquidity: $${Number(process.env.MIN_LIQUIDITY_USD).toLocaleString()}\n`;

  ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
});

// ─── LIST WALLETS ─────────────────────────────────────────────────────────────
bot.hears('📋 My Wallets', (ctx) => {
  const wallets = db.prepare('SELECT * FROM wallets ORDER BY quality_score DESC').all();

  if (wallets.length === 0) {
    return ctx.reply('No wallets tracked yet. Add one with ➕ Add Wallet.', mainMenu);
  }

  const typeEmoji = {
    sniper: '🎯',
    influencer: '📢',
    smart_money: '🧠',
    high_information: '🔮',
    copy_trader: '📋',
  };

  let msg = `📋 *Tracked Wallets (${wallets.length})*\n\n`;

  wallets.forEach((w, i) => {
    const emoji = typeEmoji[w.type] || '👛';
    const status = w.is_active ? '🟢' : '⏸';
    const short = `${w.address.slice(0, 4)}...${w.address.slice(-4)}`;
    msg += `${status} ${i + 1}. *${w.nickname}* ${emoji}\n`;
    msg += `   \`${short}\`\n`;
    msg += `   Type: ${w.type.replace('_', ' ')} | Score: ${w.quality_score}/10\n\n`;
  });

  ctx.reply(msg, { parse_mode: 'Markdown', ...mainMenu });
});

// ─── ADD WALLET — Step 1: Ask for address ────────────────────────────────────
bot.hears('➕ Add Wallet', (ctx) => {
  const session = getSession(ctx.chat.id);
  session.step = 'awaiting_address';
  session.newWallet = {};

  ctx.reply(
    '➕ *Add New Wallet*\n\nStep 1/4 — Send the Solana wallet address:',
    {
      parse_mode: 'Markdown',
      ...Markup.keyboard([['❌ Cancel']]).resize(),
    }
  );
});

// ─── REMOVE WALLET ────────────────────────────────────────────────────────────
bot.hears('❌ Remove Wallet', (ctx) => {
  const wallets = db.prepare('SELECT * FROM wallets').all();

  if (wallets.length === 0) {
    return ctx.reply('No wallets to remove.', mainMenu);
  }

  const buttons = wallets.map((w) => [
    Markup.button.callback(
      `🗑 ${w.nickname} (${w.address.slice(0, 4)}...${w.address.slice(-4)})`,
      `remove_${w.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('↩️ Cancel', 'cancel')]);

  ctx.reply('Select wallet to remove:', Markup.inlineKeyboard(buttons));
});

// ─── PAUSE WALLET ─────────────────────────────────────────────────────────────
bot.hears('⏸ Pause Wallet', (ctx) => {
  const wallets = db.prepare('SELECT * FROM wallets').all();

  if (wallets.length === 0) {
    return ctx.reply('No wallets to pause.', mainMenu);
  }

  const buttons = wallets.map((w) => [
    Markup.button.callback(
      `${w.is_active ? '⏸' : '▶️'} ${w.nickname} — ${w.is_active ? 'Pause' : 'Resume'}`,
      `toggle_${w.id}`
    ),
  ]);
  buttons.push([Markup.button.callback('↩️ Cancel', 'cancel')]);

  ctx.reply('Select wallet to pause/resume:', Markup.inlineKeyboard(buttons));
});

// ─── SETTINGS ─────────────────────────────────────────────────────────────────
bot.hears('⚙️ Settings', (ctx) => {
  ctx.reply(
    `⚙️ *Settings*\n\nTo change settings, update your \.env file and redeploy.\n\nCurrent values:\n• MIN_WALLETS=${process.env.MIN_WALLETS}\n• TIME_WINDOW_HOURS=${process.env.TIME_WINDOW_HOURS}\n• COOLDOWN_HOURS=${process.env.COOLDOWN_HOURS}\n• MIN_CONFIDENCE=${process.env.MIN_CONFIDENCE}\n• MIN_LIQUIDITY_USD=${process.env.MIN_LIQUIDITY_USD}\n• MAX_TOKEN_AGE_HOURS=${process.env.MAX_TOKEN_AGE_HOURS}`,
    { parse_mode: 'Markdown', ...mainMenu }
  );
});

// ─── CANCEL ───────────────────────────────────────────────────────────────────
bot.hears('❌ Cancel', (ctx) => {
  const session = getSession(ctx.chat.id);
  session.step = null;
  session.newWallet = {};
  ctx.reply('Cancelled.', mainMenu);
});

// ─── INLINE BUTTON: Remove wallet ────────────────────────────────────────────
bot.action(/remove_(\d+)/, (ctx) => {
  const id = parseInt(ctx.match[1]);
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);

  if (!wallet) return ctx.answerCbQuery('Wallet not found.');

  db.prepare('DELETE FROM wallets WHERE id = ?').run(id);

  // Remove Helius webhook
  if (wallet.helius_webhook_id) {
    removeWalletWebhook(wallet.helius_webhook_id).catch(err =>
      console.error('Helius removal failed:', err.message)
    );
  }

  ctx.editMessageText(`🗑 *${wallet.nickname}* removed.`, { parse_mode: 'Markdown' });
  ctx.answerCbQuery('Removed.');

  // TODO: Also remove Helius webhook for this wallet
});

// ─── INLINE BUTTON: Toggle pause ─────────────────────────────────────────────
bot.action(/toggle_(\d+)/, (ctx) => {
  const id = parseInt(ctx.match[1]);
  const wallet = db.prepare('SELECT * FROM wallets WHERE id = ?').get(id);

  if (!wallet) return ctx.answerCbQuery('Wallet not found.');

  const newStatus = wallet.is_active ? 0 : 1;
  db.prepare('UPDATE wallets SET is_active = ? WHERE id = ?').run(newStatus, id);

  const statusText = newStatus ? '▶️ Resumed' : '⏸ Paused';
  ctx.editMessageText(`${statusText}: *${wallet.nickname}*`, { parse_mode: 'Markdown' });
  ctx.answerCbQuery(statusText);
});

// ─── INLINE BUTTON: Wallet type selection ────────────────────────────────────
bot.action(/type_(.+)/, (ctx) => {
  const type = ctx.match[1];
  const session = getSession(ctx.chat.id);
  session.newWallet.type = type;
  session.step = 'awaiting_score';

  ctx.editMessageText(
    `✅ Type set: *${type.replace('_', ' ')}*\n\nStep 3/4 — Rate wallet quality (1-10):\n\n1-3 = Low quality / copy trader\n4-6 = Moderate / influencer\n7-9 = High quality / smart money\n10 = Elite / high information`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('1', 'score_1'),
          Markup.button.callback('2', 'score_2'),
          Markup.button.callback('3', 'score_3'),
          Markup.button.callback('4', 'score_4'),
          Markup.button.callback('5', 'score_5'),
        ],
        [
          Markup.button.callback('6', 'score_6'),
          Markup.button.callback('7', 'score_7'),
          Markup.button.callback('8', 'score_8'),
          Markup.button.callback('9', 'score_9'),
          Markup.button.callback('10', 'score_10'),
        ],
      ]),
    }
  );
});

// ─── INLINE BUTTON: Score selection ──────────────────────────────────────────
bot.action(/score_(\d+)/, (ctx) => {
  const score = parseInt(ctx.match[1]);
  const session = getSession(ctx.chat.id);
  session.newWallet.quality_score = score;
  session.step = 'awaiting_nickname';

  ctx.editMessageText(
    `✅ Score set: *${score}/10*\n\nStep 4/4 — Give this wallet a nickname:`,
    { parse_mode: 'Markdown' }
  );
});

// ─── INLINE BUTTON: Cancel ───────────────────────────────────────────────────
bot.action('cancel', (ctx) => {
  const session = getSession(ctx.chat.id);
  session.step = null;
  session.newWallet = {};
  ctx.editMessageText('Cancelled.');
});

// ─── TEXT HANDLER: Multi-step wallet addition ─────────────────────────────────
bot.on('text', async (ctx) => {
  const session = getSession(ctx.chat.id);
  const text = ctx.message.text.trim();

  // ── Step 1: Receive wallet address ──
  if (session.step === 'awaiting_address') {
    // Basic Solana address validation
    if (text.length < 32 || text.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
      return ctx.reply('❌ Invalid Solana address. Please try again or press Cancel.');
    }

    // Check if already tracked
    const existing = db.prepare('SELECT * FROM wallets WHERE address = ?').get(text);
    if (existing) {
      return ctx.reply(`⚠️ This wallet is already tracked as *${existing.nickname}*.`, {
        parse_mode: 'Markdown',
        ...mainMenu,
      });
    }

    session.newWallet.address = text;
    session.step = 'awaiting_type';

    return ctx.reply(
      `✅ Address saved.\n\nStep 2/4 — Select wallet type:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎯 Sniper', 'type_sniper')],
          [Markup.button.callback('🧠 Smart Money', 'type_smart_money')],
          [Markup.button.callback('🔮 High Information', 'type_high_information')],
          [Markup.button.callback('📢 Influencer', 'type_influencer')],
          [Markup.button.callback('📋 Copy Trader', 'type_copy_trader')],
        ]),
      }
    );
  }

  // ── Step 2: Receive nickname ──
  if (session.step === 'awaiting_nickname') {
    if (text.length < 1 || text.length > 30) {
      return ctx.reply('❌ Nickname must be 1-30 characters.');
    }

    session.newWallet.nickname = text;

    // Save to database
    const { address, type, quality_score, nickname } = session.newWallet;

    try {
      db.prepare(
        'INSERT INTO wallets (address, nickname, type, quality_score) VALUES (?, ?, ?, ?)'
      ).run(address, nickname, type, quality_score);

      // Auto-register with Helius
      registerWalletWebhook(address).catch(err =>
        console.error('Helius registration failed:', err.message)
      );

      session.step = null;
      session.newWallet = {};

      const typeEmoji = {
        sniper: '🎯',
        influencer: '📢',
        smart_money: '🧠',
        high_information: '🔮',
        copy_trader: '📋',
      };

      ctx.reply(
        `✅ *Wallet Added*\n\n${typeEmoji[type]} *${nickname}*\n\`${address.slice(0, 8)}...${address.slice(-8)}\`\nType: ${type.replace('_', ' ')}\nScore: ${quality_score}/10\n\n⚠️ Remember to register this wallet on Helius webhooks to start tracking.`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    } catch (err) {
      session.step = null;
      ctx.reply('❌ Error saving wallet. Please try again.', mainMenu);
    }
  }
});

module.exports = bot;
