// src/alerts/sender.js
// Formats and sends all Telegram alert types

require('dotenv').config();
const axios = require('axios');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Send raw message ─────────────────────────────────────────────────────────
async function sendMessage(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error('❌ Failed to send Telegram message:', err.message);
  }
}

// ─── CONVERGENCE ALERT ────────────────────────────────────────────────────────
async function sendConvergenceAlert(data) {
  const {
    tokenMint,
    tokenSymbol,
    tokenName,
    wallets,
    confidenceScore,
    velocityScore,
    convergenceType,
    liquidityUsd,
    marketCap,
    trustScore,
    riskWarnings,
    firstBuyAt,
    authenticityLabel,
    totalFeesSOL,
    txCount,
    dexDataAvailable,
  } = data;

  const typeLabel = {
    organic: '🌱 Organic Convergence',
    fast_momentum: '⚡ Fast Momentum Convergence',
    clustered_activity: '⚠️ Clustered Wallet Activity',
  };

  const confidenceBar = getBar(confidenceScore, 100);
  const velocityBar = getBar(velocityScore, 10);

  const walletTypeEmoji = {
    sniper: '🎯',
    influencer: '📢',
    smart_money: '🧠',
    high_information: '🔮',
    copy_trader: '📋',
  };

  // Format each wallet's buy info
  const walletLines = wallets
    .map((w) => {
      const emoji = walletTypeEmoji[w.type] || '👛';
      const time = new Date(w.timestamp).toLocaleTimeString('en-AU', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Australia/Sydney',
      });
      const sol = w.sol_spent ? `${w.sol_spent.toFixed(2)} SOL` : 'unknown';
      return `${emoji} *${w.nickname}* — ${sol} @ ${time}`;
    })
    .join('\n');

  // Risk warnings
  const riskLines =
    riskWarnings && riskWarnings.length > 0
      ? riskWarnings.map((r) => `⚠️ ${r}`).join('\n')
      : '✅ No major risks detected';

  const dexLink = `https://dexscreener.com/solana/${tokenMint}`;
  const mcFormatted = marketCap ? `$${formatNumber(marketCap)}` : 'Unknown';
  const liqFormatted = liquidityUsd ? `$${formatNumber(liquidityUsd)}` : 'Unknown';

  const msg = `
🚨 *CONVERGENCE SIGNAL*
${typeLabel[convergenceType] || convergenceType}

*${tokenSymbol || 'Unknown'}* ${tokenName ? `— ${tokenName}` : ''}
\`${tokenMint}\`

━━━━━━━━━━━━━━━━━━━━
📊 *Signal Intelligence*
Confidence: ${confidenceScore}/100 ${confidenceBar}
Velocity: ${velocityScore}/10 ${velocityBar}
Trust: ${trustScore}/100
_Confidence is directional, not predictive._

━━━━━━━━━━━━━━━━━━━━
👛 *Wallets In (${wallets.length})*
${walletLines}

━━━━━━━━━━━━━━━━━━━━
📈 *Token Data*
Market Cap: ${mcFormatted}
Liquidity: ${liqFormatted}

━━━━━━━━━━━━━━━━━━━━
🛡 *Risk Analysis*
${riskLines}

━━━━━━━━━━━━━━━━━━━━
💰 *Token Authenticity*
${authenticityLabel || 'Verifying...'}
Txs: ${txCount || 0} | Fees: ${totalFeesSOL ? totalFeesSOL.toFixed(4) + ' SOL' : 'calculating'}
${!dexDataAvailable ? '⚠️ Not yet on DexScreener — unverified, extreme caution' : ''}

━━━━━━━━━━━━━━━━━━━━
🔗 [View on DexScreener](${dexLink})

_Signals are assistive intelligence, not financial advice._
`.trim();

  await sendMessage(msg);
  console.log(`✅ Convergence alert sent for ${tokenSymbol || tokenMint}`);
}

// ─── EXIT ALERT ───────────────────────────────────────────────────────────────
async function sendExitAlert(data) {
  const { tokenSymbol, tokenMint, wallets, exitType } = data;

  const walletLines = wallets
    .map((w) => {
      const pct = w.percent_sold ? `~${w.percent_sold}% sold` : 'exited';
      return `• *${w.nickname}* — ${pct}`;
    })
    .join('\n');

  const dexLink = `https://dexscreener.com/solana/${tokenMint}`;

  const msg = `
🔴 *EXIT ALERT — ${tokenSymbol || 'Unknown'}*

${wallets.length} tracked wallet(s) selling:
${walletLines}

Exit Type: ${exitType || 'Unknown'}
\`${tokenMint}\`
[DexScreener](${dexLink})

_Consider reviewing your position._
`.trim();

  await sendMessage(msg);
  console.log(`🔴 Exit alert sent for ${tokenSymbol || tokenMint}`);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

// Visual score bar e.g. ████░░░░░░
function getBar(value, max) {
  const filled = Math.round((value / max) * 8);
  const empty = 8 - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// Format large numbers: 1200000 → 1.2M
function formatNumber(num) {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toFixed(0);
}

module.exports = { sendMessage, sendConvergenceAlert, sendExitAlert };
