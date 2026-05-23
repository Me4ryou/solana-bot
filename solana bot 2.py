"""
Solana CA Telegram Bot - v3 Final
- Pump.fun + DexScreener combo
- Axiom, Terminal, GMGN links
- All previous features intact
"""

import os
import re
import json
import asyncio
import requests
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, Bot
from telegram.ext import (
    ApplicationBuilder, MessageHandler, CallbackQueryHandler,
    ContextTypes, filters
)

# ── CONFIG ────────────────────────────────────────────────────────────────────
BOT_TOKEN = os.environ.get("BOT_TOKEN", "YOUR_BOT_TOKEN_HERE")
SYDNEY_TZ = ZoneInfo("Australia/Sydney")
CHECK_INTERVAL = 15 * 60
DEAD_THRESHOLD = 2 * 60 * 60
MILESTONE_MULTIPLIERS = [2, 5, 10, 25, 50, 100]
DATA_FILE = "calls.json"
# ─────────────────────────────────────────────────────────────────────────────

CA_PATTERN = re.compile(r'\b[1-9A-HJ-NP-Za-km-z]{32,44}\b')

# ── DATA ──────────────────────────────────────────────────────────────────────

def load_data() -> dict:
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, "r") as f:
            return json.load(f)
    return {"calls": {}}

def save_data(data: dict):
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)

# ── FORMATTERS ────────────────────────────────────────────────────────────────

def fmt_usd(val) -> str:
    if val is None:
        return "N/A"
    val = float(val)
    if val >= 1_000_000:
        return f"${val/1_000_000:.2f}M"
    if val >= 1_000:
        return f"${val/1_000:.2f}K"
    return f"${val:.4f}"

def fmt_x(x: float) -> str:
    return f"{x:.1f}x" if x < 10 else f"{int(x)}x"

def get_caller_name(user) -> str:
    if user.username:
        return f"@{user.username}"
    return user.first_name or "Someone"

def calc_age(created_ts_ms: int | None) -> str:
    if not created_ts_ms:
        return "N/A"
    try:
        created_dt = datetime.fromtimestamp(created_ts_ms / 1000, tz=SYDNEY_TZ)
        diff = datetime.now(SYDNEY_TZ) - created_dt
        hours = int(diff.total_seconds() // 3600)
        if hours < 1:
            mins = int(diff.total_seconds() // 60)
            return f"{mins}m"
        if hours < 24:
            return f"{hours}h"
        return f"{hours // 24}d"
    except Exception:
        return "N/A"

def build_links(ca: str) -> str:
    axiom = f"https://axiom.trade/t/{ca}"
    terminal = f"https://terminal.padre.trade/terminal/{ca}"
    gmgn = f"https://gmgn.ai/sol/token/{ca}"
    return f'🔗 <a href="{axiom}">Axiom</a> | <a href="{terminal}">Terminal</a> | <a href="{gmgn}">GMGN</a>'

# ── PUMP.FUN API ──────────────────────────────────────────────────────────────

def fetch_pumpfun_data(ca: str) -> dict | None:
    try:
        url = f"https://frontend-api.pump.fun/coins/{ca}"
        res = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
        if res.status_code != 200:
            return None
        data = res.json()
        if not data or "mint" not in data:
            return None
        return data
    except Exception:
        return None

# ── DEXSCREENER API ───────────────────────────────────────────────────────────

def fetch_dex_data(ca: str) -> dict | None:
    try:
        url = f"https://api.dexscreener.com/latest/dex/tokens/{ca}"
        res = requests.get(url, timeout=10)
        res.raise_for_status()
        pairs = res.json().get("pairs")
        if not pairs:
            return None
        return sorted(pairs, key=lambda p: p.get("liquidity", {}).get("usd", 0), reverse=True)[0]
    except Exception:
        return None

# ── COMBINED FETCH ────────────────────────────────────────────────────────────

def fetch_token(ca: str) -> dict | None:
    pf = fetch_pumpfun_data(ca)
    dex = fetch_dex_data(ca)

    if not pf and not dex:
        return None

    result = {}

    if pf:
        result["name"] = pf.get("name", "Unknown")
        result["symbol"] = pf.get("symbol", "?")
        result["image_url"] = pf.get("image_uri") or pf.get("uri")
        mc = pf.get("market_cap") or pf.get("usd_market_cap")
        result["mc"] = float(mc) if mc else None
        result["created_timestamp"] = pf.get("created_timestamp")
        result["pre_dex"] = not pf.get("raydium_pool")
        result["price"] = pf.get("price") or pf.get("sol_price")

    if dex:
        base = dex.get("baseToken", {})
        if not pf:
            result["name"] = base.get("name", "Unknown")
            result["symbol"] = base.get("symbol", "?")
            info = dex.get("info", {})
            result["image_url"] = info.get("imageUrl") if isinstance(info.get("imageUrl"), str) else None
        result["liquidity"] = float(dex.get("liquidity", {}).get("usd", 0)) or None
        result["volume24h"] = float(dex.get("volume", {}).get("h24", 0)) or None
        result["holders"] = dex.get("holders")
        result["dex_paid"] = bool(dex.get("boosts", {}).get("active", 0))
        result["cto"] = "cto" in [l.lower() for l in dex.get("labels", [])]
        dex_mc = dex.get("marketCap") or dex.get("fdv")
        if dex_mc:
            result["mc"] = float(dex_mc)
        if not pf:
            result["created_timestamp"] = dex.get("pairCreatedAt")
        result["price"] = float(dex.get("priceUsd", 0)) or result.get("price")
        result["pre_dex"] = False

    return result

# ── MESSAGE BUILDER ───────────────────────────────────────────────────────────

def build_message(ca: str, token: dict, caller: str) -> tuple[str, str | None]:
    name = token.get("name", "Unknown")
    symbol = token.get("symbol", "?")
    mc = token.get("mc")
    liquidity = token.get("liquidity")
    volume24h = token.get("volume24h")
    holders = token.get("holders")
    dex_paid = token.get("dex_paid", False)
    cto = token.get("cto", False)
    age = calc_age(token.get("created_timestamp"))
    image_url = token.get("image_url")
    pre_dex = token.get("pre_dex", False)

    lines = [f"🪙 <b>{name} (${symbol})</b>"]

    if pre_dex:
        lines.append("⚡ <b>Pre-DEX — Pump.fun</b>")

    lines += ["", f"📋 <b>CA:</b> <code>{ca}</code>", "", f"💰 <b>Market Cap:</b> {fmt_usd(mc)}"]

    if liquidity:
        lines.append(f"💧 <b>Liquidity:</b> {fmt_usd(liquidity)}")
    if volume24h:
        lines.append(f"📊 <b>Volume 24h:</b> {fmt_usd(volume24h)}")

    lines.append(f"🕐 <b>Age:</b> {age}")
    lines.append(f"👥 <b>Total Holders:</b> {int(holders):,}" if holders else "👥 <b>Total Holders:</b> N/A")

    if not pre_dex:
        lines += ["", f"Dexscreener Paid: {'✅' if dex_paid else '❌'}", f"CTO: {'✅' if cto else '❌'}"]

    lines += [
        "",
        f"🏅 First call by {caller} @ <b>{fmt_usd(mc)}</b> MC",
        "",
        build_links(ca),
    ]

    return "\n".join(lines), image_url

# ── HANDLERS ──────────────────────────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg or not msg.text:
        return

    matches = CA_PATTERN.findall(msg.text)
    if not matches:
        return

    ca = matches[0]
    data = load_data()

    if ca in data["calls"]:
        existing = data["calls"][ca]
        caller = existing["caller"]
        entry_mc = existing.get("entry_mc")
        current = existing.get("current_price", existing["entry_price"])
        entry = existing["entry_price"]
        mult = current / entry if entry > 0 else 1
        await msg.reply_text(
            f"⚠️ Already called by {caller} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
            f"📈 Currently at <b>{fmt_x(mult)}</b> from entry",
            parse_mode="HTML"
        )
        return

    thinking = await msg.reply_text("🔍 Fetching token data...")
    token = fetch_token(ca)

    if not token:
        await thinking.edit_text("❌ Could not find token data. May not be listed yet.")
        return

    caller = get_caller_name(msg.from_user)
    text, image_url = build_message(ca, token, caller)

    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("📋 Copy CA", callback_data=f"copy:{ca}")]
    ])
    await thinking.delete()

    if image_url:
        try:
            await msg.reply_photo(photo=image_url, caption=text, parse_mode="HTML", reply_markup=keyboard)
        except Exception:
            await msg.reply_text(text, parse_mode="HTML", reply_markup=keyboard)
    else:
        await msg.reply_text(text, parse_mode="HTML", reply_markup=keyboard)

    price = token.get("price")
    mc = token.get("mc")
    if price:
        data["calls"][ca] = {
            "chat_id": msg.chat_id,
            "name": token.get("name", "Unknown"),
            "symbol": token.get("symbol", "?"),
            "caller": caller,
            "entry_price": float(price),
            "entry_mc": mc,
            "current_price": float(price),
            "current_mc": mc,
            "entry_time": datetime.now(SYDNEY_TZ).isoformat(),
            "milestones_hit": [],
            "last_volume_time": datetime.now(SYDNEY_TZ).isoformat(),
            "active": True
        }
        save_data(data)


async def handle_copy_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer(text=query.data.replace("copy:", ""), show_alert=True)


# ── PRICE MONITOR ─────────────────────────────────────────────────────────────

async def monitor_prices(bot: Bot):
    while True:
        await asyncio.sleep(CHECK_INTERVAL)
        data = load_data()
        changed = False
        now = datetime.now(SYDNEY_TZ)

        for ca, info in data["calls"].items():
            if not info.get("active", True):
                continue

            token = fetch_token(ca)
            if not token:
                continue

            current_price = token.get("price")
            current_mc = token.get("mc")
            volume = token.get("volume24h") or 0

            if not current_price:
                continue

            current_price = float(current_price)

            if volume > 0:
                info["last_volume_time"] = now.isoformat()
            else:
                last_vol = datetime.fromisoformat(info["last_volume_time"])
                if (now - last_vol).total_seconds() > DEAD_THRESHOLD:
                    info["active"] = False
                    changed = True
                    continue

            entry_price = info["entry_price"]
            entry_mc = info.get("entry_mc")
            multiplier = current_price / entry_price
            info["current_price"] = current_price
            info["current_mc"] = current_mc
            changed = True

            for m in MILESTONE_MULTIPLIERS:
                if multiplier >= m and m not in info["milestones_hit"]:
                    info["milestones_hit"].append(m)
                    alert = (
                        f"🚀 <b>{info['name']} (${info['symbol']}) hit {m}x!</b>\n\n"
                        f"📋 <code>{ca}</code>\n"
                        f"🏅 First called by {info['caller']} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
                        f"📈 Now: <b>{fmt_usd(current_mc)}</b> MC — <b>{fmt_x(multiplier)}</b> from entry\n\n"
                        f"{build_links(ca)}"
                    )
                    try:
                        await bot.send_message(chat_id=info["chat_id"], text=alert, parse_mode="HTML")
                    except Exception:
                        pass

        if changed:
            save_data(data)


# ── DAILY TOP 10 ──────────────────────────────────────────────────────────────

async def daily_top10(bot: Bot):
    while True:
        now = datetime.now(SYDNEY_TZ)
        target = now.replace(hour=12, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        await asyncio.sleep((target - now).total_seconds())

        data = load_data()
        now = datetime.now(SYDNEY_TZ)
        cutoff = now - timedelta(hours=24)

        calls = []
        for ca, info in data["calls"].items():
            entry_time = datetime.fromisoformat(info["entry_time"])
            if entry_time < cutoff or not info.get("active", True):
                continue
            entry = info["entry_price"]
            current = info.get("current_price", entry)
            if entry > 0 and current > entry:
                calls.append((ca, info, current / entry))

        if not calls:
            continue

        calls.sort(key=lambda x: x[2], reverse=True)
        top10 = calls[:10]
        chat_id = top10[0][1]["chat_id"]

        medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"]
        lines = [
            "🏆 <b>Top 10 Calls — Last 24hrs</b>",
            f"📅 {now.strftime('%d %b %Y, %I:%M %p')} AEST\n"
        ]
        for i, (ca, info, mult) in enumerate(top10):
            lines.append(
                f"{medals[i]} <b>${info['symbol']}</b> — <b>{fmt_x(mult)}</b>\n"
                f"   👤 {info['caller']} @ {fmt_usd(info.get('entry_mc'))} → {fmt_usd(info.get('current_mc'))}\n"
                f"   <code>{ca[:20]}...</code>"
            )

        try:
            await bot.send_message(chat_id=chat_id, text="\n".join(lines), parse_mode="HTML")
        except Exception:
            pass


# ── MAIN ──────────────────────────────────────────────────────────────────────

async def post_init(app):
    asyncio.create_task(monitor_prices(app.bot))
    asyncio.create_task(daily_top10(app.bot))

def main():
    app = ApplicationBuilder().token(BOT_TOKEN).post_init(post_init).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_copy_button, pattern=r"^copy:"))
    print("✅ Bot running!")
    app.run_polling()

if __name__ == "__main__":
    main()
