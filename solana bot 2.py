"""
Solana Alpha Telegram Bot — Final Version
Fixed: event loop conflict
"""

import os
import re
import json
import asyncio
import aiohttp
import aiosqlite

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ApplicationBuilder, MessageHandler, CallbackQueryHandler,
    CommandHandler, ContextTypes, filters
)

# ── CONFIG ────────────────────────────────────────────────────────────────────
BOT_TOKEN = os.getenv("BOT_TOKEN")
CHANNEL_ID = -1003777694895
SYDNEY_TZ = ZoneInfo("Australia/Sydney")
CHECK_INTERVAL = 5 * 60
GROWTH_ALERT_THRESHOLD = 0.30
DEAD_THRESHOLD = 2 * 60 * 60
MILESTONES = [2, 5, 10, 25, 50, 100]
DB_FILE = "solbot.db"
CA_PATTERN = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")
# ─────────────────────────────────────────────────────────────────────────────

# ── DATABASE ──────────────────────────────────────────────────────────────────

async def init_db():
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
        CREATE TABLE IF NOT EXISTS calls (
            ca TEXT PRIMARY KEY,
            chat_id INTEGER,
            name TEXT,
            symbol TEXT,
            caller TEXT,
            entry_price REAL,
            current_price REAL,
            last_checked_price REAL,
            entry_mc REAL,
            current_mc REAL,
            milestones TEXT,
            created_at TEXT,
            last_volume_at TEXT,
            active INTEGER
        )
        """)
        await db.commit()

# ── FORMATTERS ────────────────────────────────────────────────────────────────

def fmt_usd(val) -> str:
    if not val:
        return "N/A"
    val = float(val)
    if val >= 1_000_000:
        return f"${val/1_000_000:.2f}M"
    if val >= 1_000:
        return f"${val/1_000:.2f}K"
    return f"${val:.4f}"

def fmt_x(x: float) -> str:
    return f"{x:.1f}x" if x < 10 else f"{int(x)}x"

def fmt_pct(x: float) -> str:
    return f"+{x*100:.1f}%" if x >= 0 else f"{x*100:.1f}%"

def get_caller(user) -> str:
    if user.username:
        return f"@{user.username}"
    return user.first_name or "Someone"

def calc_age(ts_ms) -> str:
    if not ts_ms:
        return "N/A"
    try:
        created = datetime.fromtimestamp(float(ts_ms) / 1000, tz=SYDNEY_TZ)
        diff = datetime.now(SYDNEY_TZ) - created
        hours = int(diff.total_seconds() // 3600)
        if hours < 1:
            return f"{int(diff.total_seconds() // 60)}m"
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

# ── API FETCHERS ──────────────────────────────────────────────────────────────

async def fetch_pumpfun(session, ca):
    try:
        url = f"https://frontend-api.pump.fun/coins/{ca}"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10),
                               headers={"User-Agent": "Mozilla/5.0"}) as res:
            if res.status != 200:
                return None
            data = await res.json()
            return data if "mint" in data else None
    except Exception:
        return None

async def fetch_dex(session, ca):
    try:
        url = f"https://api.dexscreener.com/latest/dex/tokens/{ca}"
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as res:
            if res.status != 200:
                return None
            data = await res.json()
            pairs = data.get("pairs")
            if not pairs:
                return None
            return sorted(pairs, key=lambda p: p.get("liquidity", {}).get("usd", 0), reverse=True)[0]
    except Exception:
        return None

async def fetch_token(ca: str) -> dict | None:
    async with aiohttp.ClientSession() as session:
        pf, dex = await asyncio.gather(
            fetch_pumpfun(session, ca),
            fetch_dex(session, ca)
        )

    if not pf and not dex:
        return None

    token = {}

    if pf:
        token["name"] = pf.get("name", "Unknown")
        token["symbol"] = pf.get("symbol", "?")
        token["image"] = pf.get("image_uri")
        mc = pf.get("market_cap") or pf.get("usd_market_cap")
        token["mc"] = float(mc) if mc else None
        token["price"] = pf.get("price")
        token["created_ts"] = pf.get("created_timestamp")
        token["pre_dex"] = not pf.get("raydium_pool")

    if dex:
        base = dex.get("baseToken", {})
        if not token.get("name"):
            token["name"] = base.get("name", "Unknown")
            token["symbol"] = base.get("symbol", "?")
            info = dex.get("info", {})
            token["image"] = info.get("imageUrl") if isinstance(info.get("imageUrl"), str) else None
        token["liquidity"] = dex.get("liquidity", {}).get("usd")
        token["volume"] = dex.get("volume", {}).get("h24")
        token["holders"] = dex.get("holders")
        token["dex_paid"] = bool(dex.get("boosts", {}).get("active", 0))
        token["cto"] = "cto" in [x.lower() for x in dex.get("labels", [])]
        dex_mc = dex.get("marketCap") or dex.get("fdv")
        if dex_mc:
            token["mc"] = float(dex_mc)
        if dex.get("priceUsd"):
            token["price"] = float(dex["priceUsd"])
        if not token.get("created_ts"):
            token["created_ts"] = dex.get("pairCreatedAt")
        token["pre_dex"] = False

    return token

# ── MESSAGE BUILDER ───────────────────────────────────────────────────────────

def build_message(ca: str, token: dict, caller: str) -> tuple[str, str | None]:
    name = token.get("name", "Unknown")
    symbol = token.get("symbol", "?")
    mc = token.get("mc")
    liquidity = token.get("liquidity")
    volume = token.get("volume")
    holders = token.get("holders")
    dex_paid = token.get("dex_paid", False)
    cto = token.get("cto", False)
    pre_dex = token.get("pre_dex", False)
    age = calc_age(token.get("created_ts"))
    image = token.get("image")

    lines = [f"🪙 <b>{name} (${symbol})</b>"]

    if pre_dex:
        lines.append("⚡ <b>Pre-DEX — Pump.fun</b>")

    lines += [
        "",
        f"📋 <b>CA:</b> <code>{ca}</code>",
        "",
        f"💰 <b>Market Cap:</b> {fmt_usd(mc)}",
    ]

    if liquidity:
        lines.append(f"💧 <b>Liquidity:</b> {fmt_usd(liquidity)}")
    if volume:
        lines.append(f"📊 <b>Volume 24h:</b> {fmt_usd(volume)}")

    lines.append(f"🕐 <b>Age:</b> {age}")
    lines.append(f"👥 <b>Holders:</b> {int(holders):,}" if holders else "👥 <b>Holders:</b> N/A")

    if not pre_dex:
        lines += [
            "",
            f"Dexscreener Paid: {'✅' if dex_paid else '❌'}",
            f"CTO: {'✅' if cto else '❌'}",
        ]

    lines += [
        "",
        f"🏅 First call by {caller} @ <b>{fmt_usd(mc)}</b> MC",
        "",
        build_links(ca),
    ]

    return "\n".join(lines), image

# ── HANDLERS ──────────────────────────────────────────────────────────────────

async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    if not msg or not msg.text:
        return

    matches = CA_PATTERN.findall(msg.text)
    if not matches:
        return

    ca = matches[0]

    async with aiosqlite.connect(DB_FILE) as db:
        cursor = await db.execute("SELECT * FROM calls WHERE ca=?", (ca,))
        existing = await cursor.fetchone()

    if existing:
        entry_price = existing[5]
        current_price = existing[6]
        mult = current_price / entry_price if entry_price else 1
        await msg.reply_text(
            f"⚠️ Already called by {existing[4]} @ <b>{fmt_usd(existing[8])}</b> MC\n"
            f"📈 Currently at <b>{fmt_x(mult)}</b> from entry",
            parse_mode="HTML"
        )
        return

    thinking = await msg.reply_text("🔍 Fetching token data...")
    token = await fetch_token(ca)

    if not token:
        await thinking.edit_text("❌ Token not found. May not be listed yet.")
        return

    caller = get_caller(msg.from_user)
    text, image = build_message(ca, token, caller)

    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton("📋 Copy CA", callback_data=f"copy:{ca}")]
    ])

    await thinking.delete()

    try:
        if image:
            await msg.reply_photo(photo=image, caption=text, parse_mode="HTML", reply_markup=keyboard)
        else:
            await msg.reply_text(text, parse_mode="HTML", reply_markup=keyboard)
    except Exception:
        await msg.reply_text(text, parse_mode="HTML", reply_markup=keyboard)

    # Mirror to channel
    try:
        if image:
            await context.bot.send_photo(chat_id=CHANNEL_ID, photo=image,
                                          caption=text, parse_mode="HTML", reply_markup=keyboard)
        else:
            await context.bot.send_message(chat_id=CHANNEL_ID, text=text,
                                            parse_mode="HTML", reply_markup=keyboard)
    except Exception:
        pass

    price = float(token.get("price") or 0)
    mc = float(token.get("mc") or 0)
    now = datetime.now(SYDNEY_TZ).isoformat()

    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute("""
        INSERT OR IGNORE INTO calls
        (ca, chat_id, name, symbol, caller, entry_price, current_price, last_checked_price,
         entry_mc, current_mc, milestones, created_at, last_volume_at, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (ca, msg.chat_id, token.get("name"), token.get("symbol"),
              caller, price, price, price, mc, mc, json.dumps([]), now, now, 1))
        await db.commit()


async def handle_copy(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer(text=query.data.replace("copy:", ""), show_alert=True)


async def handle_mystats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.message
    caller = get_caller(msg.from_user)

    async with aiosqlite.connect(DB_FILE) as db:
        cursor = await db.execute("""
        SELECT name, symbol, entry_mc, current_mc, entry_price, current_price, active
        FROM calls WHERE caller=? ORDER BY (current_price/entry_price) DESC
        """, (caller,))
        rows = await cursor.fetchall()

    if not rows:
        await msg.reply_text(f"📊 {caller} — no calls yet!")
        return

    total = len(rows)
    winning = sum(1 for r in rows if r[5] > r[4])
    best = max(rows, key=lambda r: r[5]/r[4] if r[4] else 1)
    best_mult = best[5] / best[4] if best[4] else 1

    lines = [
        f"📊 <b>Stats for {caller}</b>\n",
        f"📞 Total Calls: <b>{total}</b>",
        f"✅ Winning: <b>{winning}</b>",
        f"❌ Losing: <b>{total - winning}</b>",
        f"🏆 Best Call: <b>${best[1]}</b> — <b>{fmt_x(best_mult)}</b>",
        f"   Entry: {fmt_usd(best[2])} → Now: {fmt_usd(best[3])}\n",
        "<b>Recent Calls:</b>"
    ]

    for r in rows[:5]:
        mult = r[5] / r[4] if r[4] else 1
        status = "🟢" if r[5] > r[4] else "🔴"
        lines.append(f"{status} <b>${r[1]}</b> — {fmt_x(mult)} {'(active)' if r[6] else '(dead)'}")

    await msg.reply_text("\n".join(lines), parse_mode="HTML")

# ── PRICE MONITOR ─────────────────────────────────────────────────────────────

async def monitor_prices(app):
    while True:
        await asyncio.sleep(CHECK_INTERVAL)
        now = datetime.now(SYDNEY_TZ)

        async with aiosqlite.connect(DB_FILE) as db:
            cursor = await db.execute("SELECT * FROM calls WHERE active=1")
            rows = await cursor.fetchall()

        for row in rows:
            ca = row[0]
            chat_id, name, symbol, caller = row[1], row[2], row[3], row[4]
            entry_price, last_checked_price = row[5], row[7]
            entry_mc = row[8]
            milestones = json.loads(row[10])
            created_at = datetime.fromisoformat(row[11])
            last_volume_at = datetime.fromisoformat(row[12])

            token = await fetch_token(ca)
            if not token:
                continue

            current_price = float(token.get("price") or 0)
            current_mc = token.get("mc")
            volume = float(token.get("volume") or 0)

            if not current_price:
                continue

            if volume > 0:
                last_volume_at = now
            else:
                if (now - last_volume_at).total_seconds() > DEAD_THRESHOLD:
                    async with aiosqlite.connect(DB_FILE) as db:
                        await db.execute("UPDATE calls SET active=0 WHERE ca=?", (ca,))
                        await db.commit()
                    dead_msg = (
                        f"💀 <b>${symbol} is dead</b>\n\n"
                        f"📋 <code>{ca}</code>\n"
                        f"🏅 Called by {caller} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
                        f"📉 Final: <b>{fmt_usd(current_mc)}</b> MC"
                    )
                    try:
                        await app.bot.send_message(chat_id=chat_id, text=dead_msg, parse_mode="HTML")
                    except Exception:
                        pass
                    continue

            multiplier = current_price / entry_price if entry_price else 1

            # 5 min growth alert
            if last_checked_price and last_checked_price > 0:
                growth = (current_price - last_checked_price) / last_checked_price
                if growth >= GROWTH_ALERT_THRESHOLD:
                    growth_msg = (
                        f"📈 <b>${symbol} is pumping!</b>\n\n"
                        f"📋 <code>{ca}</code>\n"
                        f"🏅 Called by {caller} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
                        f"🚀 Up <b>{fmt_pct(growth)}</b> in last 5 mins\n"
                        f"💰 Now: <b>{fmt_usd(current_mc)}</b> MC — <b>{fmt_x(multiplier)}</b> from entry\n\n"
                        f"{build_links(ca)}"
                    )
                    try:
                        await app.bot.send_message(chat_id=chat_id, text=growth_msg, parse_mode="HTML")
                    except Exception:
                        pass

            # Lightning call
            time_since_call = (now - created_at).total_seconds()
            if multiplier >= 2 and time_since_call <= 3600 and "lightning" not in milestones:
                milestones.append("lightning")
                lightning_msg = (
                    f"⚡ <b>Lightning Call!</b>\n\n"
                    f"<b>${symbol}</b> hit 2x in under 1 hour!\n"
                    f"📋 <code>{ca}</code>\n"
                    f"🏅 Called by {caller} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
                    f"📈 Now: <b>{fmt_usd(current_mc)}</b> MC\n\n"
                    f"{build_links(ca)}"
                )
                try:
                    await app.bot.send_message(chat_id=chat_id, text=lightning_msg, parse_mode="HTML")
                except Exception:
                    pass

            # Milestones
            for m in MILESTONES:
                if multiplier >= m and m not in milestones:
                    milestones.append(m)
                    alert = (
                        f"🚀 <b>{name} (${symbol}) hit {m}x!</b>\n\n"
                        f"📋 <code>{ca}</code>\n"
                        f"🏅 First called by {caller} @ <b>{fmt_usd(entry_mc)}</b> MC\n"
                        f"📈 Now: <b>{fmt_usd(current_mc)}</b> MC — <b>{fmt_x(multiplier)}</b>\n\n"
                        f"{build_links(ca)}"
                    )
                    try:
                        await app.bot.send_message(chat_id=chat_id, text=alert, parse_mode="HTML")
                    except Exception:
                        pass

            async with aiosqlite.connect(DB_FILE) as db:
                await db.execute("""
                UPDATE calls SET current_price=?, last_checked_price=?, current_mc=?,
                last_volume_at=?, milestones=? WHERE ca=?
                """, (current_price, current_price, current_mc,
                      last_volume_at.isoformat(), json.dumps(milestones), ca))
                await db.commit()

# ── MORNING SUMMARY ───────────────────────────────────────────────────────────

async def morning_summary(app):
    while True:
        now = datetime.now(SYDNEY_TZ)
        target = now.replace(hour=11, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        await asyncio.sleep((target - now).total_seconds())

        async with aiosqlite.connect(DB_FILE) as db:
            cursor = await db.execute("""
            SELECT ca, chat_id, name, symbol, caller, entry_price, current_price, entry_mc, current_mc
            FROM calls WHERE active=1 ORDER BY (current_price/entry_price) DESC
            """)
            rows = await cursor.fetchall()

        if not rows:
            continue

        now = datetime.now(SYDNEY_TZ)
        chat_id = rows[0][1]
        lines = [
            "🌅 <b>Morning Summary</b>",
            f"📅 {now.strftime('%d %b %Y, %I:%M %p')} AEST\n",
            f"📊 <b>{len(rows)} active coins being tracked</b>\n"
        ]
        for row in rows:
            _, _, name, symbol, caller, entry_price, current_price, entry_mc, current_mc = row
            mult = current_price / entry_price if entry_price else 1
            emoji = "🟢" if mult >= 1 else "🔴"
            lines.append(f"{emoji} <b>${symbol}</b> — <b>{fmt_x(mult)}</b>\n   👤 {caller} @ {fmt_usd(entry_mc)} → {fmt_usd(current_mc)}")

        try:
            await app.bot.send_message(chat_id=chat_id, text="\n".join(lines), parse_mode="HTML")
        except Exception:
            pass

# ── DAILY TOP 10 ──────────────────────────────────────────────────────────────

async def daily_top10(app):
    while True:
        now = datetime.now(SYDNEY_TZ)
        target = now.replace(hour=12, minute=0, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        await asyncio.sleep((target - now).total_seconds())

        now = datetime.now(SYDNEY_TZ)
        cutoff = (now - timedelta(hours=24)).isoformat()

        async with aiosqlite.connect(DB_FILE) as db:
            cursor = await db.execute("""
            SELECT ca, chat_id, name, symbol, caller, entry_price, current_price, entry_mc, current_mc
            FROM calls WHERE active=1 AND created_at >= ? AND current_price > entry_price
            ORDER BY (current_price/entry_price) DESC LIMIT 10
            """, (cutoff,))
            rows = await cursor.fetchall()

        if not rows:
            continue

        chat_id = rows[0][1]
        medals = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"]
        lines = [
            "🏆 <b>Top 10 Calls — Last 24hrs</b>",
            f"📅 {now.strftime('%d %b %Y, %I:%M %p')} AEST\n"
        ]
        for i, row in enumerate(rows):
            ca, _, name, symbol, caller, entry_price, current_price, entry_mc, current_mc = row
            mult = current_price / entry_price if entry_price else 1
            lines.append(
                f"{medals[i]} <b>${symbol}</b> — <b>{fmt_x(mult)}</b>\n"
                f"   👤 {caller} @ {fmt_usd(entry_mc)} → {fmt_usd(current_mc)}\n"
                f"   <code>{ca[:20]}...</code>"
            )

        try:
            await app.bot.send_message(chat_id=chat_id, text="\n".join(lines), parse_mode="HTML")
        except Exception:
            pass

# ── MAIN ──────────────────────────────────────────────────────────────────────

async def post_init(app):
    await init_db()
    asyncio.create_task(monitor_prices(app))
    asyncio.create_task(morning_summary(app))
    asyncio.create_task(daily_top10(app))

def main():
    app = ApplicationBuilder().token(BOT_TOKEN).post_init(post_init).build()
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_copy, pattern=r"^copy:"))
    app.add_handler(CommandHandler("mystats", handle_mystats))
    print("✅ Solana Alpha Bot Running!")
    app.run_polling()

if __name__ == "__main__":
    main()
