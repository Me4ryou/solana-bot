"""
Solana CA Telegram Bot
- Watches your group for a Solana contract address
- Fetches token data from DexScreener (free, no API key needed)
- Replies with token image, stats, and a copy CA button

SETUP:
1. pip install python-telegram-bot requests
2. Replace BOT_TOKEN below with your token from @BotFather
3. Run: python solana_bot.py
"""

import re
import requests
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, MessageHandler, CallbackQueryHandler,
    ContextTypes, filters
)

# ── CONFIG ────────────────────────────────────────────────────────────────────
BOT_TOKEN = "7756554416:AAFZI9qA2lOYlOP1VpbIp5Cxo2QNjALe6X4"   # Get this from @BotFather on Telegram
# ─────────────────────────────────────────────────────────────────────────────

# Solana CA pattern: base58, 32-44 chars
CA_PATTERN = re.compile(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b')


def fetch_token_data(ca: str) -> dict | None:
    """Fetch token info from DexScreener API."""
    try:
        url = f"https://api.dexscreener.com/latest/dex/tokens/{ca}"
        res = requests.get(url, timeout=10)
        res.raise_for_status()
        data = res.json()
        pairs = data.get("pairs")
        if not pairs:
            return None
        # Pick the pair with highest liquidity
        pair = sorted(pairs, key=lambda p: p.get("liquidity", {}).get("usd", 0), reverse=True)[0]
        return pair
    except Exception:
        return None


def fmt_usd(val) -> str:
    if val is None:
        return "N/A"
    val = float(val)
    if val >= 1_000_000:
        return f"${val/1_000_000:.2f}M"
    if val >= 1_000:
        return f"${val/1_000:.2f}K"
    return f"${val:.2f}"


def build_message(ca: str, pair: dict) -> tuple[str, str | None]:
    """Returns (text, image_url)."""
    base = pair.get("baseToken", {})
    name = base.get("name", "Unknown")
    symbol = base.get("symbol", "?")
    mc = pair.get("marketCap") or pair.get("fdv")
    info = pair.get("info", {})
    
    # Image
    image_url = None
    for img in info.get("imageUrl", []):
        image_url = img
        break
    if not image_url:
        image_url = info.get("imageUrl") if isinstance(info.get("imageUrl"), str) else None

    # Holders — DexScreener doesn't always provide this; show if available
    holders = pair.get("holders", None)

    # Dexscreener Paid (boosted = paid profile)
    boosts = pair.get("boosts", {})
    dex_paid = bool(boosts.get("active", 0))

    # CTO: heuristic — if creator label exists in labels list
    labels = pair.get("labels", [])
    cto = "cto" in [l.lower() for l in labels]

    lines = [
        f"🪙 <b>{name} (${symbol})</b>",
        "",
        f"📋 <b>CA:</b> <code>{ca}</code>",
        "",
        f"💰 <b>Market Cap:</b> {fmt_usd(mc)}",
    ]

    if holders is not None:
        lines.append(f"👥 <b>Total Holders:</b> {int(holders):,}")
    else:
        lines.append(f"👥 <b>Total Holders:</b> N/A")

    lines += [
        "",
        f"Dexscreener Paid: {'✅' if dex_paid else '❌'}",
        f"CTO: {'✅' if cto else '❌'}",
    ]

    return "\n".join(lines), image_url


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg or not msg.text:
        return

    matches = CA_PATTERN.findall(msg.text)
    if not matches:
        return

    ca = matches[0]  # Use first CA found in the message

    # Immediately acknowledge
    thinking = await msg.reply_text("🔍 Fetching token data...")

    pair = fetch_token_data(ca)

    if not pair:
        await thinking.edit_text("❌ Could not find token data for that CA. Make sure it's a valid Solana token.")
        return

    text, image_url = build_message(ca, pair)

    # Inline button to copy CA (clicking shows CA in an alert popup)
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(f"📋 Copy CA", callback_data=f"copy:{ca}")]
    ])

    await thinking.delete()

    if image_url:
        try:
            await msg.reply_photo(
                photo=image_url,
                caption=text,
                parse_mode="HTML",
                reply_markup=keyboard
            )
            return
        except Exception:
            pass  # Fall back to text if image fails

    await msg.reply_text(text, parse_mode="HTML", reply_markup=keyboard)


async def handle_copy_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """When user taps Copy CA button, show CA in a popup."""
    query = update.callback_query
    await query.answer(
        text=query.data.replace("copy:", ""),
        show_alert=True   # Shows as a popup the user can long-press to copy
    )


def main():
    app = ApplicationBuilder().token(BOT_TOKEN).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_copy_button, pattern=r"^copy:"))
    print("✅ Bot is running. Post a Solana CA in your group!")
    app.run_polling()


if __name__ == "__main__":
    main()
