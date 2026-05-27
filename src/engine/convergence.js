// src/engine/convergence.js
// The brain of the system — detects convergence, scores signals, classifies types

require('dotenv').config();
const db = require('../db/database');
const { sendConvergenceAlert, sendExitAlert } = require('../alerts/sender');
const { getTokenData } = require('../utils/dexscreener');
const { getTokenAuthenticity, checkMintAuthority } = require('../utils/helius');

const TIME_WINDOW_MS = (parseInt(process.env.TIME_WINDOW_HOURS) || 2) * 60 * 60 * 1000;
const MIN_WALLETS = parseInt(process.env.MIN_WALLETS) || 3;
const MIN_CONFIDENCE = parseInt(process.env.MIN_CONFIDENCE) || 40;
const COOLDOWN_HOURS = parseInt(process.env.COOLDOWN_HOURS) || 4;

// ─── WALLET TYPE WEIGHTS ──────────────────────────────────────────────────────
// How much each wallet type contributes to the conviction score
const TYPE_WEIGHTS = {
  high_information: 3.0,  // Strongest signal
  sniper:           2.5,
  smart_money:      2.0,
  influencer:       1.2,
  copy_trader:      0.7,  // Weakest signal
};

// ─── MAIN ENTRY POINT ─────────────────────────────────────────────────────────
// Called every time a tracked wallet makes a buy
async function processBuyEvent(event) {
  const { walletAddress, tokenMint, solSpent, tokenAmount, txSignature, timestamp } = event;

  console.log(`\n🔍 Processing buy: ${walletAddress.slice(0,8)}... bought ${tokenMint.slice(0,8)}...`);

  try {
    // 1. Get wallet info
    const wallet = db.prepare(
      'SELECT * FROM wallets WHERE address = ? AND is_active = 1'
    ).get(walletAddress);

    if (!wallet) {
      console.log('⚠️ Wallet not found or inactive, skipping.');
      return;
    }

    // 2. Save buy event to database
    try {
      db.prepare(`
        INSERT OR IGNORE INTO buy_events 
        (wallet_address, token_mint, sol_spent, token_amount, tx_signature, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(walletAddress, tokenMint, solSpent, tokenAmount, txSignature, timestamp);
    } catch (err) {
      console.log('⚠️ Duplicate tx, skipping:', txSignature);
      return;
    }

    // 3. Check cooldown — don't re-alert for same token too soon
    const cooldownCheck = db.prepare(`
      SELECT * FROM alerts 
      WHERE token_mint = ? 
      AND cooldown_until > datetime('now')
    `).get(tokenMint);

    if (cooldownCheck) {
      console.log(`⏳ Token ${tokenMint.slice(0,8)}... still in cooldown, skipping alert.`);
      return;
    }

    // 4. Get all buys for this token within the rolling 2hr window
    const windowStart = new Date(Date.now() - TIME_WINDOW_MS).toISOString();
    const recentBuys = db.prepare(`
      SELECT b.*, w.nickname, w.type, w.quality_score
      FROM buy_events b
      JOIN wallets w ON b.wallet_address = w.address
      WHERE b.token_mint = ?
      AND b.timestamp > ?
      AND w.is_active = 1
      ORDER BY b.timestamp ASC
    `).all(tokenMint, windowStart);

    // Deduplicate by wallet (keep most recent buy per wallet)
    const uniqueWalletBuys = deduplicateByWallet(recentBuys);

    console.log(`📊 Unique wallets in window: ${uniqueWalletBuys.length} / ${MIN_WALLETS} needed`);

    // 5. Check if we hit minimum wallet threshold
    if (uniqueWalletBuys.length < MIN_WALLETS) {
      console.log('⏳ Not enough wallets yet, waiting...');
      return;
    }

    // 6. Calculate all scores
    const velocityScore = calculateVelocity(uniqueWalletBuys);
    const convictionScore = calculateConviction(uniqueWalletBuys);
    const convergenceType = classifyConvergenceType(uniqueWalletBuys, velocityScore);

    // 7. Get token data from DexScreener
    const tokenData = await getTokenData(tokenMint);

    // 8. Get fee authenticity from Helius RPC
    // Key insight: fees relative to age = organic activity signal
    const ageHours = tokenData?.ageHours || null;
    const authenticity = await getTokenAuthenticity(tokenMint, ageHours);

    // 9. Get mint authority (rug check) from Helius RPC
    const mintData = await checkMintAuthority(tokenMint);
    if (tokenData) {
      tokenData.mintAuthority = mintData.mintAuthority;
      tokenData.freezeAuthority = mintData.freezeAuthority;
    }

    // 10. Apply freshness bias penalties
    const freshnessMultiplier = calculateFreshnessBias(tokenData);

    // 11. Calculate final confidence score (0-100)
    // KOL convergence (50%) + velocity (25%) + trust (15%) + fee authenticity (10%)
    const rawConfidence =
      (convictionScore * 0.5) +
      (velocityScore * 2.5) +
      (tokenData?.trustScore || 50) * 0.15 +
      (authenticity.authenticityScore) * 0.10;
    const confidenceScore = Math.min(100, Math.round(rawConfidence * freshnessMultiplier));

    console.log(`📈 Scores — Conviction: ${convictionScore.toFixed(1)}, Velocity: ${velocityScore.toFixed(1)}/10, Confidence: ${confidenceScore}/100`);

    // 10. Check minimum confidence threshold
    if (confidenceScore < MIN_CONFIDENCE) {
      console.log(`⚠️ Confidence ${confidenceScore} below minimum ${MIN_CONFIDENCE}, skipping alert.`);
      return;
    }

    // 11. Run risk filter — skip obvious rugs
    const riskWarnings = evaluateRisk(tokenData);
    if (riskWarnings.includes('HARD_REJECT')) {
      console.log('🚫 Token failed hard risk filter, no alert.');
      return;
    }

    // 12. Fire the alert
    await sendConvergenceAlert({
      tokenMint,
      tokenSymbol: tokenData?.symbol,
      tokenName: tokenData?.name,
      wallets: uniqueWalletBuys,
      confidenceScore,
      velocityScore: parseFloat(velocityScore.toFixed(1)),
      convergenceType,
      liquidityUsd: tokenData?.liquidityUsd,
      marketCap: tokenData?.marketCap,
      trustScore: tokenData?.trustScore || 50,
      riskWarnings: riskWarnings.filter(r => r !== 'HARD_REJECT'),
      firstBuyAt: uniqueWalletBuys[0]?.timestamp,
      authenticityLabel: authenticity.label,
      totalFeesSOL: authenticity.totalFeesSOL,
      txCount: authenticity.txCount,
      dexDataAvailable: !!tokenData,
    });

    // 13. Log alert and set cooldown
    const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO alerts (token_mint, token_symbol, confidence_score, wallet_count, convergence_type, cooldown_until)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tokenMint, tokenData?.symbol, confidenceScore, uniqueWalletBuys.length, convergenceType, cooldownUntil);

    console.log(`✅ Alert fired for ${tokenData?.symbol || tokenMint.slice(0,8)}!`);

  } catch (err) {
    console.error('❌ Error in convergence engine:', err.message);
  }
}

// ─── VELOCITY SCORE (0-10) ────────────────────────────────────────────────────
// Measures how fast wallets are piling in
// Faster = higher score
function calculateVelocity(buys) {
  if (buys.length < 2) return 0;

  const times = buys.map(b => new Date(b.timestamp).getTime());
  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const spanMinutes = (lastTime - firstTime) / (1000 * 60);

  if (spanMinutes === 0) return 10; // All at same time = max velocity

  // Score formula: more wallets in less time = higher score
  // 3 wallets in 5 mins ≈ 9/10
  // 3 wallets in 30 mins ≈ 6/10
  // 3 wallets in 90 mins ≈ 3/10
  const score = Math.max(0, 10 - (spanMinutes / (buys.length * 5)));
  return Math.min(10, score);
}

// ─── CONVICTION SCORE ─────────────────────────────────────────────────────────
// Weighted by wallet type, quality score, and buy size
function calculateConviction(buys) {
  let totalScore = 0;

  buys.forEach(buy => {
    const typeWeight = TYPE_WEIGHTS[buy.type] || 1.0;
    const qualityWeight = buy.quality_score / 10; // 0.1 to 1.0
    const sizeWeight = getBuySizeWeight(buy.sol_spent);

    const walletScore = typeWeight * qualityWeight * sizeWeight * 10;
    totalScore += walletScore;
  });

  return totalScore;
}

// Buy size multiplier
// Small buy = 0.5x, Medium = 1x, Large = 1.5x, Whale = 2x
function getBuySizeWeight(solSpent) {
  if (!solSpent) return 0.8; // Unknown size, moderate weight
  if (solSpent < 0.5)  return 0.5;
  if (solSpent < 2)    return 0.8;
  if (solSpent < 5)    return 1.0;
  if (solSpent < 15)   return 1.3;
  return 1.6; // 15+ SOL = whale buy
}

// ─── CONVERGENCE TYPE CLASSIFICATION ──────────────────────────────────────────
function classifyConvergenceType(buys, velocityScore) {
  // Check if these wallets frequently buy together (clustered activity)
  const isClusterRisk = detectClusterRisk(buys);
  if (isClusterRisk) return 'clustered_activity';

  // Fast momentum: velocity score above 7
  if (velocityScore >= 7) return 'fast_momentum';

  // Default: organic convergence
  return 'organic';
}

// Detect if wallets have a history of buying together
// (possible coordinated behavior)
function detectClusterRisk(buys) {
  if (buys.length < 2) return false;

  const walletAddresses = buys.map(b => b.wallet_address);

  // Check how many times these exact wallets appeared together in past alerts
  const pastAlerts = db.prepare(`
    SELECT token_mint FROM buy_events
    WHERE wallet_address IN (${walletAddresses.map(() => '?').join(',')})
    AND timestamp > datetime('now', '-7 days')
    GROUP BY token_mint
    HAVING COUNT(DISTINCT wallet_address) >= ?
  `).all(...walletAddresses, Math.min(2, walletAddresses.length));

  // If 3+ past co-occurrences, flag as clustered activity
  return pastAlerts.length >= 3;
}

// ─── FRESHNESS BIAS ───────────────────────────────────────────────────────────
// Penalize tokens that are already pumped or trending
function calculateFreshnessBias(tokenData) {
  if (!tokenData) return 1.0;

  let multiplier = 1.0;

  // Penalty if token is already trending on DexScreener
  if (tokenData.isTrending) {
    multiplier *= 0.6;
    console.log('📉 Freshness penalty: already trending on DexScreener');
  }

  // Penalty if market cap is already high (>$5M for a meme coin = likely pumped)
  if (tokenData.marketCap > 5_000_000) {
    multiplier *= 0.7;
    console.log('📉 Freshness penalty: market cap already high');
  }

  // Penalty if token is older than configured max age
  const maxAgeHours = parseInt(process.env.MAX_TOKEN_AGE_HOURS) || 24;
  if (tokenData.ageHours && tokenData.ageHours > maxAgeHours) {
    multiplier *= 0.5;
    console.log(`📉 Freshness penalty: token older than ${maxAgeHours}hrs`);
  }

  return multiplier;
}

// ─── RISK FILTER ──────────────────────────────────────────────────────────────
// Returns array of risk warnings. 'HARD_REJECT' = don't alert at all.
function evaluateRisk(tokenData) {
  const warnings = [];
  if (!tokenData) return ['No token data available'];

  const minLiquidity = parseFloat(process.env.MIN_LIQUIDITY_USD) || 5000;

  // Hard rejects — don't alert
  if (tokenData.liquidityUsd < minLiquidity) {
    warnings.push('HARD_REJECT');
    warnings.push(`Liquidity too low ($${tokenData.liquidityUsd?.toFixed(0)})`);
    return warnings;
  }

  if (tokenData.mintAuthority && tokenData.mintAuthority !== 'null') {
    warnings.push('HARD_REJECT');
    warnings.push('Mint authority not revoked — rug risk');
    return warnings;
  }

  // Soft warnings — alert but flag
  if (tokenData.freezeAuthority && tokenData.freezeAuthority !== 'null') {
    warnings.push('Freeze authority active');
  }

  if (tokenData.isTrending) {
    warnings.push('Already trending — may be crowded entry');
  }

  if (tokenData.marketCap > 5_000_000) {
    warnings.push('Market cap already elevated');
  }

  if (tokenData.ageHours && tokenData.ageHours > 24) {
    warnings.push(`Token is ${Math.round(tokenData.ageHours)}hrs old`);
  }

  return warnings;
}

// ─── PROCESS SELL/EXIT EVENT ──────────────────────────────────────────────────
async function processExitEvent(event) {
  const { walletAddress, tokenMint, percentSold, txSignature, timestamp } = event;

  try {
    const wallet = db.prepare('SELECT * FROM wallets WHERE address = ?').get(walletAddress);
    if (!wallet) return;

    // Save exit event
    db.prepare(`
      INSERT OR IGNORE INTO exit_events 
      (wallet_address, token_mint, percent_sold, tx_signature, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(walletAddress, tokenMint, percentSold, txSignature, timestamp);

    // Check how many wallets are exiting this token within last 30 mins
    const recentExits = db.prepare(`
      SELECT e.*, w.nickname, w.type
      FROM exit_events e
      JOIN wallets w ON e.wallet_address = w.address
      WHERE e.token_mint = ?
      AND e.timestamp > datetime('now', '-30 minutes')
    `).all(tokenMint);

    // Alert if 2+ wallets are exiting
    if (recentExits.length >= 2) {
      const tokenData = await getTokenData(tokenMint);
      await sendExitAlert({
        tokenSymbol: tokenData?.symbol || tokenMint.slice(0, 8),
        tokenMint,
        wallets: recentExits,
        exitType: recentExits.length >= 3 ? 'Mass Exit' : 'Multiple Exits',
      });
    }

  } catch (err) {
    console.error('❌ Error processing exit event:', err.message);
  }
}

// ─── HELPER: Remove duplicate wallet buys ────────────────────────────────────
// Keep only the most recent buy per wallet in the window
function deduplicateByWallet(buys) {
  const seen = {};
  buys.forEach(buy => {
    if (!seen[buy.wallet_address] ||
        new Date(buy.timestamp) > new Date(seen[buy.wallet_address].timestamp)) {
      seen[buy.wallet_address] = buy;
    }
  });
  return Object.values(seen);
}

module.exports = { processBuyEvent, processExitEvent };
