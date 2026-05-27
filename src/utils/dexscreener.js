// src/utils/dexscreener.js
// Fetches token data from DexScreener — free, no API key needed

const axios = require('axios');
const db = require('../db/database');

const CACHE_TTL_MS = 5 * 60 * 1000; // Cache token data for 5 minutes

// ─── GET TOKEN DATA ───────────────────────────────────────────────────────────
async function getTokenData(tokenMint) {
  try {
    // Check cache first
    const cached = db.prepare(`
      SELECT * FROM token_cache 
      WHERE token_mint = ? 
      AND last_updated > datetime('now', '-5 minutes')
    `).get(tokenMint);

    if (cached) {
      console.log(`📦 Token data from cache: ${cached.symbol}`);
      return formatCachedToken(cached);
    }

    // Fetch from DexScreener
    console.log(`🌐 Fetching token data from DexScreener: ${tokenMint.slice(0, 8)}...`);
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`,
      { timeout: 8000 }
    );

    const pairs = response.data?.pairs;
    if (!pairs || pairs.length === 0) {
      console.log('⚠️ No DexScreener data found for token');
      return null;
    }

    // Use the pair with highest liquidity (most reliable data)
    const bestPair = pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (!bestPair) return null;

    // Calculate token age in hours
    const createdAt = bestPair.pairCreatedAt
      ? new Date(bestPair.pairCreatedAt)
      : null;
    const ageHours = createdAt
      ? (Date.now() - createdAt.getTime()) / (1000 * 60 * 60)
      : null;

    // Check if trending (top boosted on DexScreener)
    const isTrending = await checkIfTrending(tokenMint);

    // Calculate basic trust score
    const trustScore = calculateTrustScore({
      liquidityUsd: bestPair.liquidity?.usd,
      marketCap: bestPair.marketCap,
      ageHours,
      isTrending,
      volume24h: bestPair.volume?.h24,
    });

    const tokenData = {
      symbol: bestPair.baseToken?.symbol,
      name: bestPair.baseToken?.name,
      liquidityUsd: bestPair.liquidity?.usd || 0,
      marketCap: bestPair.marketCap || 0,
      priceUsd: parseFloat(bestPair.priceUsd) || 0,
      ageHours,
      isTrending,
      mintAuthority: null, // DexScreener doesn't provide this — would need RPC call
      freezeAuthority: null,
      trustScore,
      volume24h: bestPair.volume?.h24 || 0,
    };

    // Save to cache
    db.prepare(`
      INSERT OR REPLACE INTO token_cache 
      (token_mint, symbol, name, liquidity_usd, market_cap, price_usd, 
       created_at_chain, is_trending, trust_score, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      tokenMint,
      tokenData.symbol,
      tokenData.name,
      tokenData.liquidityUsd,
      tokenData.marketCap,
      tokenData.priceUsd,
      createdAt?.toISOString(),
      isTrending ? 1 : 0,
      tokenData.trustScore,
    );

    return tokenData;

  } catch (err) {
    console.error('❌ DexScreener fetch error:', err.message);
    return null;
  }
}

// ─── CHECK IF TOKEN IS TRENDING ON DEXSCREENER ───────────────────────────────
async function checkIfTrending(tokenMint) {
  try {
    const response = await axios.get(
      'https://api.dexscreener.com/token-boosts/top/v1',
      { timeout: 5000 }
    );

    const boosted = response.data;
    if (!Array.isArray(boosted)) return false;

    return boosted.some(
      t => t.tokenAddress?.toLowerCase() === tokenMint.toLowerCase()
    );
  } catch {
    return false; // Fail silently
  }
}

// ─── TRUST SCORE (0-100) ──────────────────────────────────────────────────────
// Basic scoring based on available data
function calculateTrustScore({ liquidityUsd, marketCap, ageHours, isTrending, volume24h }) {
  let score = 50; // Start neutral

  // Liquidity scoring
  if (liquidityUsd >= 50_000)      score += 20;
  else if (liquidityUsd >= 20_000) score += 10;
  else if (liquidityUsd >= 5_000)  score += 0;
  else                             score -= 20;

  // Age scoring (fresh but not brand new)
  if (ageHours !== null) {
    if (ageHours < 0.5)   score -= 10; // Too new, suspicious
    else if (ageHours < 6) score += 15; // Fresh and active
    else if (ageHours < 24) score += 5;
    else                   score -= 10; // Old, likely already played
  }

  // Volume relative to liquidity (high ratio = suspicious wash trading)
  if (liquidityUsd > 0 && volume24h > 0) {
    const volLiqRatio = volume24h / liquidityUsd;
    if (volLiqRatio > 50) score -= 15; // Suspicious volume
    else if (volLiqRatio > 5) score += 5;
  }

  // Already trending = crowded
  if (isTrending) score -= 10;

  return Math.max(0, Math.min(100, score));
}

// ─── FORMAT CACHED TOKEN ──────────────────────────────────────────────────────
function formatCachedToken(cached) {
  const ageHours = cached.created_at_chain
    ? (Date.now() - new Date(cached.created_at_chain).getTime()) / (1000 * 60 * 60)
    : null;

  return {
    symbol: cached.symbol,
    name: cached.name,
    liquidityUsd: cached.liquidity_usd,
    marketCap: cached.market_cap,
    priceUsd: cached.price_usd,
    ageHours,
    isTrending: cached.is_trending === 1,
    mintAuthority: cached.mint_authority,
    freezeAuthority: cached.freeze_authority,
    trustScore: cached.trust_score,
  };
}

module.exports = { getTokenData };
