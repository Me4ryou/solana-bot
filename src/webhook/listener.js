// src/webhook/listener.js
// Receives real-time transaction data from Helius and feeds into convergence engine

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { processBuyEvent, processExitEvent } = require('../engine/convergence');
const db = require('../db/database');

const router = express.Router();

// ─── ASYNC QUEUE ──────────────────────────────────────────────────────────────
// Prevents webhook spikes from overwhelming the engine
// Processes one event at a time in order
const queue = [];
let isProcessing = false;

async function addToQueue(event) {
  queue.push(event);
  if (!isProcessing) processQueue();
}

async function processQueue() {
  if (queue.length === 0) {
    isProcessing = false;
    return;
  }
  isProcessing = true;
  const event = queue.shift();
  try {
    if (event.type === 'buy') await processBuyEvent(event);
    if (event.type === 'sell') await processExitEvent(event);
  } catch (err) {
    console.error('❌ Queue processing error:', err.message);
  }
  // Process next item
  setImmediate(processQueue);
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
// Helius will POST to this endpoint for every tracked wallet transaction
router.post('/helius', async (req, res) => {
  // Respond immediately so Helius doesn't retry
  res.status(200).json({ received: true });

  try {
    const transactions = req.body;
    if (!Array.isArray(transactions) || transactions.length === 0) return;

    for (const tx of transactions) {
      await parseAndQueue(tx);
    }
  } catch (err) {
    console.error('❌ Webhook parse error:', err.message);
  }
});

// ─── PARSE TRANSACTION ────────────────────────────────────────────────────────
async function parseAndQueue(tx) {
  try {
    // Only process successful transactions
    if (tx.transactionError) {
      console.log('⚠️ Skipping failed tx:', tx.signature?.slice(0, 8));
      return;
    }

    const txType = tx.type;
    const signature = tx.signature;
    const timestamp = new Date(tx.timestamp * 1000).toISOString();
    const feePayer = tx.feePayer;

    // ── Detect swap/buy ──
    if (txType === 'SWAP') {
      const swapData = extractSwapData(tx);
      if (!swapData) return;

      const { tokenMint, solSpent, tokenAmount, walletAddress } = swapData;

      // Verify this wallet is one we're tracking
      const trackedWallet = db.prepare(
        'SELECT * FROM wallets WHERE address = ? AND is_active = 1'
      ).get(walletAddress);

      if (!trackedWallet) return;

      console.log(`\n📥 Swap detected: ${trackedWallet.nickname} → ${tokenMint.slice(0, 8)}...`);
      console.log(`   SOL spent: ${solSpent?.toFixed(3)}, Sig: ${signature?.slice(0, 8)}...`);

      // Determine if buy or sell based on SOL flow
      const isBuy = solSpent > 0; // SOL going out = buying token

      if (isBuy) {
        await addToQueue({
          type: 'buy',
          walletAddress,
          tokenMint,
          solSpent,
          tokenAmount,
          txSignature: signature,
          timestamp,
        });
      } else {
        // SOL coming in = selling token
        const percentSold = estimateSellPercent(walletAddress, tokenMint, tokenAmount);
        await addToQueue({
          type: 'sell',
          walletAddress,
          tokenMint,
          percentSold,
          txSignature: signature,
          timestamp,
        });
      }
    }

    // ── Also handle TOKEN_TRANSFER as potential buy/sell ──
    if (txType === 'TRANSFER') {
      // Ignore pure transfers — not relevant to our signal
      return;
    }

  } catch (err) {
    console.error('❌ Parse error for tx:', err.message);
  }
}

// ─── EXTRACT SWAP DATA ────────────────────────────────────────────────────────
// Pulls token mint, SOL amount, and wallet from Helius swap event
function extractSwapData(tx) {
  try {
    const events = tx.events?.swap;
    if (!events) return null;

    const nativeInput = events.nativeInput;
    const nativeOutput = events.nativeOutput;
    const tokenInputs = events.tokenInputs || [];
    const tokenOutputs = events.tokenOutputs || [];

    let tokenMint = null;
    let solSpent = 0;
    let tokenAmount = 0;
    let walletAddress = tx.feePayer;

    // SOL → Token (Buy)
    if (nativeInput && tokenOutputs.length > 0) {
      solSpent = nativeInput.amount / 1e9; // lamports to SOL
      tokenMint = tokenOutputs[0].mint;
      tokenAmount = tokenOutputs[0].rawTokenAmount?.tokenAmount
        ? parseFloat(tokenOutputs[0].rawTokenAmount.tokenAmount)
        : 0;
    }

    // Token → SOL (Sell)
    else if (nativeOutput && tokenInputs.length > 0) {
      solSpent = -(nativeOutput.amount / 1e9); // Negative = receiving SOL
      tokenMint = tokenInputs[0].mint;
      tokenAmount = tokenInputs[0].rawTokenAmount?.tokenAmount
        ? parseFloat(tokenInputs[0].rawTokenAmount.tokenAmount)
        : 0;
    }

    // Token → Token swap (ignore for now)
    else {
      return null;
    }

    // Filter out SOL/WSOL and stablecoins — we only want meme coins
    const IGNORED_MINTS = [
      'So11111111111111111111111111111111111111112',  // Wrapped SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
    ];

    if (!tokenMint || IGNORED_MINTS.includes(tokenMint)) return null;

    return { tokenMint, solSpent, tokenAmount, walletAddress };

  } catch (err) {
    console.error('❌ extractSwapData error:', err.message);
    return null;
  }
}

// ─── ESTIMATE SELL PERCENT ────────────────────────────────────────────────────
// Rough estimate of how much of their position they sold
function estimateSellPercent(walletAddress, tokenMint, tokenAmountSold) {
  try {
    // Get total tokens bought by this wallet for this mint
    const totalBought = db.prepare(`
      SELECT SUM(token_amount) as total
      FROM buy_events
      WHERE wallet_address = ? AND token_mint = ?
    `).get(walletAddress, tokenMint);

    if (!totalBought?.total || totalBought.total === 0) return null;

    const percent = (tokenAmountSold / totalBought.total) * 100;
    return Math.min(100, Math.round(percent));
  } catch {
    return null;
  }
}

// ─── HELIUS WEBHOOK REGISTRATION ─────────────────────────────────────────────
// Registers a wallet address with Helius to start receiving webhooks
async function registerWalletWebhook(walletAddress) {
  try {
    const apiKey = process.env.HELIUS_API_KEY;
    const webhookUrl = `${process.env.WEBHOOK_URL}/webhook/helius`;

    // Get existing webhooks first
    const existing = await axios.get(
      `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`
    );

    const webhooks = existing.data || [];

    // Check if we already have a webhook for this wallet
    const alreadyExists = webhooks.find(wh =>
      wh.accountAddresses?.includes(walletAddress)
    );

    if (alreadyExists) {
      console.log(`✅ Webhook already exists for ${walletAddress.slice(0, 8)}...`);
      return alreadyExists.webhookID;
    }

    // Create new webhook
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`,
      {
        webhookURL: webhookUrl,
        transactionTypes: ['SWAP'],
        accountAddresses: [walletAddress],
        webhookType: 'enhanced',
      }
    );

    const webhookId = response.data?.webhookID;
    console.log(`✅ Helius webhook registered for ${walletAddress.slice(0, 8)}... ID: ${webhookId}`);

    // Save webhook ID to database
    db.prepare(
      'UPDATE wallets SET helius_webhook_id = ? WHERE address = ?'
    ).run(webhookId, walletAddress);

    return webhookId;

  } catch (err) {
    console.error('❌ Failed to register Helius webhook:', err.message);
    return null;
  }
}

// ─── REMOVE HELIUS WEBHOOK ────────────────────────────────────────────────────
async function removeWalletWebhook(webhookId) {
  try {
    const apiKey = process.env.HELIUS_API_KEY;
    await axios.delete(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${apiKey}`
    );
    console.log(`🗑 Helius webhook removed: ${webhookId}`);
    return true;
  } catch (err) {
    console.error('❌ Failed to remove Helius webhook:', err.message);
    return false;
  }
}

// ─── GET ALL REGISTERED WEBHOOKS ─────────────────────────────────────────────
async function getRegisteredWebhooks() {
  try {
    const apiKey = process.env.HELIUS_API_KEY;
    const response = await axios.get(
      `https://api.helius.xyz/v0/webhooks?api-key=${apiKey}`
    );
    return response.data || [];
  } catch (err) {
    console.error('❌ Failed to fetch webhooks:', err.message);
    return [];
  }
}

module.exports = {
  router,
  registerWalletWebhook,
  removeWalletWebhook,
  getRegisteredWebhooks,
};
