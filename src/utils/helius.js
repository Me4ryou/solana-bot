// src/utils/helius.js
// Uses Helius RPC to fetch global fee data for token authenticity scoring

require('dotenv').config();
const axios = require('axios');

const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

// ─── GET TOKEN AUTHENTICITY DATA ─────────────────────────────────────────────
// Fetches transaction history for a token mint and calculates total fees paid
// This is our authenticity signal — fees can't be faked cheaply
async function getTokenAuthenticity(tokenMint, tokenAgeHours) {
  try {
    console.log(`🔍 Checking token authenticity: ${tokenMint.slice(0, 8)}...`);

    // Get recent transaction signatures for this mint
    const signatures = await getTokenSignatures(tokenMint);

    if (!signatures || signatures.length === 0) {
      return {
        totalFeesSOL: 0,
        txCount: 0,
        authenticityScore: getEarlyStageScore(tokenAgeHours),
        label: getAgeLabel(0, tokenAgeHours),
      };
    }

    // Calculate total fees from signatures
    // Each tx on Solana costs ~0.000005 SOL base fee
    // Higher activity = more fees = more authentic
    const txCount = signatures.length;
    const estimatedFeesSOL = txCount * 0.000005;

    // Get actual fee data from a sample of transactions
    const actualFees = await sampleActualFees(signatures.slice(0, 20));
    const totalFeesSOL = actualFees || estimatedFeesSOL;

    // Calculate authenticity score relative to token age
    const authenticityScore = calculateAuthenticityScore(totalFeesSOL, txCount, tokenAgeHours);
    const label = getAgeLabel(totalFeesSOL, tokenAgeHours);

    console.log(`💰 Token fees: ${totalFeesSOL.toFixed(4)} SOL across ${txCount} txs — ${label}`);

    return {
      totalFeesSOL,
      txCount,
      authenticityScore,
      label,
    };

  } catch (err) {
    console.error('❌ getTokenAuthenticity error:', err.message);
    return {
      totalFeesSOL: 0,
      txCount: 0,
      authenticityScore: 50, // Neutral if we can't check
      label: 'Unable to verify',
    };
  }
}

// ─── GET TOKEN TRANSACTION SIGNATURES ────────────────────────────────────────
async function getTokenSignatures(tokenMint) {
  try {
    const response = await axios.post(
      HELIUS_RPC,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getSignaturesForAddress',
        params: [
          tokenMint,
          { limit: 100 }, // Get last 100 transactions
        ],
      },
      { timeout: 8000 }
    );

    return response.data?.result || [];
  } catch (err) {
    console.error('❌ getSignaturesForAddress error:', err.message);
    return [];
  }
}

// ─── SAMPLE ACTUAL FEES ───────────────────────────────────────────────────────
// Gets real fee data from a sample of transactions
async function sampleActualFees(signatures) {
  try {
    if (!signatures || signatures.length === 0) return 0;

    const sigStrings = signatures.map(s => s.signature).filter(Boolean);
    if (sigStrings.length === 0) return 0;

    // Batch fetch transaction details
    const response = await axios.post(
      HELIUS_RPC,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getTransactions',
        params: [sigStrings, { commitment: 'confirmed' }],
      },
      { timeout: 10000 }
    );

    const txs = response.data?.result || [];
    let totalFees = 0;

    txs.forEach(tx => {
      if (tx?.meta?.fee) {
        totalFees += tx.meta.fee; // In lamports
      }
    });

    // Convert lamports to SOL and extrapolate to full tx count
    const sampledFeesSOL = totalFees / 1e9;
    const multiplier = signatures.length / sigStrings.length;
    return sampledFeesSOL * multiplier;

  } catch (err) {
    return null; // Fall back to estimate
  }
}

// ─── AUTHENTICITY SCORE (0-100) ───────────────────────────────────────────────
// Key insight: fees are only meaningful relative to token age
// Early coins naturally have low fees — don't penalize them
function calculateAuthenticityScore(totalFeesSOL, txCount, tokenAgeHours) {

  // Very new token (under 30 mins) — fee data is not meaningful yet
  // Score based purely on tx count showing early organic activity
  if (!tokenAgeHours || tokenAgeHours < 0.5) {
    return getEarlyStageScore(tokenAgeHours);
  }

  // Calculate expected fees for this age
  // Healthy organic token: ~10-50 txs per hour on average
  const expectedTxPerHour = 20;
  const expectedFees = tokenAgeHours * expectedTxPerHour * 0.000005;

  const feeRatio = totalFeesSOL / expectedFees;

  let score = 50; // Start neutral

  if (feeRatio >= 2.0)       score = 85; // Very active, well above expected
  else if (feeRatio >= 1.0)  score = 70; // Healthy activity
  else if (feeRatio >= 0.5)  score = 55; // Slightly below expected, ok
  else if (feeRatio >= 0.2)  score = 40; // Low activity for age
  else                       score = 25; // Very low — suspicious for age

  // Bonus for high absolute tx count regardless of age
  if (txCount > 500) score = Math.min(100, score + 10);
  if (txCount > 100) score = Math.min(100, score + 5);

  return score;
}

// Early stage coins get a neutral-positive score
// Don't penalize what we can't yet measure
function getEarlyStageScore(tokenAgeHours) {
  if (!tokenAgeHours || tokenAgeHours < 0.1) return 60; // Brand new, neutral positive
  if (tokenAgeHours < 0.5) return 65; // Under 30 mins, give benefit of doubt
  return 55;
}

// ─── HUMAN READABLE LABEL ─────────────────────────────────────────────────────
function getAgeLabel(totalFeesSOL, tokenAgeHours) {
  if (!tokenAgeHours || tokenAgeHours < 0.5) {
    return `Token ${Math.round((tokenAgeHours || 0) * 60)} mins old — fee data building ✅`;
  }

  const expectedTxPerHour = 20;
  const expectedFees = tokenAgeHours * expectedTxPerHour * 0.000005;
  const feeRatio = totalFeesSOL / (expectedFees || 0.0001);

  if (feeRatio >= 1.0) return `Healthy fee activity for age ✅`;
  if (feeRatio >= 0.5) return `Moderate fee activity for age 🟡`;
  return `Low fee activity for age ⚠️`;
}

// ─── CHECK MINT AUTHORITY ─────────────────────────────────────────────────────
// Check if mint authority is revoked (important rug check)
async function checkMintAuthority(tokenMint) {
  try {
    const response = await axios.post(
      HELIUS_RPC,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'getAccountInfo',
        params: [
          tokenMint,
          { encoding: 'jsonParsed' },
        ],
      },
      { timeout: 8000 }
    );

    const info = response.data?.result?.value?.data?.parsed?.info;
    if (!info) return { mintAuthority: 'unknown', freezeAuthority: 'unknown' };

    return {
      mintAuthority: info.mintAuthority || null,
      freezeAuthority: info.freezeAuthority || null,
    };

  } catch (err) {
    console.error('❌ checkMintAuthority error:', err.message);
    return { mintAuthority: 'unknown', freezeAuthority: 'unknown' };
  }
}

module.exports = {
  getTokenAuthenticity,
  checkMintAuthority,
};
