// src/utils/webhookManager.js
// Standalone Helius webhook registration — no circular dependencies

require('dotenv').config();
const axios = require('axios');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

async function registerWalletWebhook(walletAddress) {
  try {
    const webhookUrl = `${process.env.WEBHOOK_URL}/webhook/helius`;

    // Get existing webhooks
    const existing = await axios.get(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`
    );

    const webhooks = existing.data || [];

    // Check if already registered
    const alreadyExists = webhooks.find(wh =>
      wh.accountAddresses?.includes(walletAddress)
    );

    if (alreadyExists) {
      console.log(`✅ Webhook already exists for ${walletAddress.slice(0, 8)}...`);
      return alreadyExists.webhookID;
    }

    // Create new webhook
    const response = await axios.post(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`,
      {
        webhookURL: webhookUrl,
        transactionTypes: ['SWAP'],
        accountAddresses: [walletAddress],
        webhookType: 'enhanced',
      }
    );

    const webhookId = response.data?.webhookID;
    console.log(`✅ Helius webhook registered: ${walletAddress.slice(0, 8)}... → ${webhookId}`);
    return webhookId;

  } catch (err) {
    console.error('❌ registerWalletWebhook error:', err.message);
    return null;
  }
}

async function removeWalletWebhook(webhookId) {
  try {
    await axios.delete(
      `https://api.helius.xyz/v0/webhooks/${webhookId}?api-key=${HELIUS_API_KEY}`
    );
    console.log(`🗑 Webhook removed: ${webhookId}`);
    return true;
  } catch (err) {
    console.error('❌ removeWalletWebhook error:', err.message);
    return false;
  }
}

async function getRegisteredWebhooks() {
  try {
    const response = await axios.get(
      `https://api.helius.xyz/v0/webhooks?api-key=${HELIUS_API_KEY}`
    );
    return response.data || [];
  } catch (err) {
    console.error('❌ getRegisteredWebhooks error:', err.message);
    return [];
  }
}

module.exports = { registerWalletWebhook, removeWalletWebhook, getRegisteredWebhooks };
