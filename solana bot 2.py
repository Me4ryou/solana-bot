"""
Solana Alpha Telegram Bot — Clean Production Version
Features:
- Async aiohttp requests
- Pump.fun + DexScreener fetch
- SQLite storage
- Milestone alerts
- Dex buttons
- Cleaner architecture in one file

REQUIREMENTS:
pip install python-telegram-bot aiohttp aiosqlite

ENV:
BOT_TOKEN=your_telegram_bot_token
"""

import os
import re
import json
import asyncio
import aiohttp
import aiosqlite

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup
)

from telegram.ext import (
    ApplicationBuilder,
    MessageHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters
)

# ───────────────── CONFIG ─────────────────

BOT_TOKEN = os.getenv("BOT_TOKEN")

SYDNEY_TZ = ZoneInfo("Australia/Sydney")

CHECK_INTERVAL = 15 * 60
MILESTONES = [2, 5, 10, 25, 50, 100]

DB_FILE = "solbot.db"

CA_PATTERN = re.compile(r"\b[1-9A-HJ-NP-Za-km-z]{32,44}\b")

# ───────────────── DATABASE ─────────────────


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
            entry_mc REAL,
            current_mc REAL,
            milestones TEXT,
            created_at TEXT,
            active INTEGER
        )
        """)

        await db.commit()


# ───────────────── HELPERS ─────────────────


def fmt_usd(value):

    if not value:
        return "N/A"

    value = float(value)

    if value >= 1_000_000:
        return f"${value/1_000_000:.2f}M"

    if value >= 1_000:
        return f"${value/1_000:.2f}K"

    return f"${value:.4f}"


def fmt_x(value):

    if value < 10:
        return f"{value:.1f}x"

    return f"{int(value)}x"


def get_caller(user):

    if user.username:
        return f"@{user.username}"

    return user.first_name or "Unknown"


# ───────────────── API FETCHERS ─────────────────


async def fetch_pumpfun(session, ca):

    try:

        url = f"https://frontend-api.pump.fun/coins/{ca}"

        async with session.get(
            url,
            timeout=10,
            headers={"User-Agent": "Mozilla/5.0"}
        ) as res:

            if res.status != 200:
                return None

            data = await res.json()

            if "mint" not in data:
                return None

            return data

    except:
        return None


async def fetch_dex(session, ca):

    try:

        url = f"https://api.dexscreener.com/latest/dex/tokens/{ca}"

        async with session.get(url, timeout=10) as res:

            if res.status != 200:
                return None

            data = await res.json()

            pairs = data.get("pairs")

            if not pairs:
                return None

            return sorted(
                pairs,
                key=lambda p: p.get("liquidity", {}).get("usd", 0),
                reverse=True
            )[0]

    except:
        return None


async def fetch_token(ca):

    async with aiohttp.ClientSession() as session:

        pf_task = fetch_pumpfun(session, ca)
        dex_task = fetch_dex(session, ca)

        pf, dex = await asyncio.gather(
            pf_task,
            dex_task
        )

        if not pf and not dex:
            return None

        token = {}

        # ── PUMPFUN DATA ──

        if pf:

            token["name"] = pf.get("name", "Unknown")
            token["symbol"] = pf.get("symbol", "?")
            token["image"] = pf.get("image_uri")
            token["description"] = pf.get("description", "")

            mc = pf.get("market_cap") or pf.get("usd_market_cap")

            token["mc"] = float(mc) if mc else None

            token["price"] = pf.get("price")

            token["pre_dex"] = not pf.get("raydium_pool")

        # ── DEX DATA ──

        if dex:

            base = dex.get("baseToken", {})

            if not token.get("name"):
                token["name"] = base.get("name", "Unknown")
                token["symbol"] = base.get("symbol", "?")

            token["liquidity"] = dex.get("liquidity", {}).get("usd")

            token["volume"] = dex.get("volume", {}).get("h24")

            token["holders"] = dex.get("holders")

            token["dex_paid"] = bool(
                dex.get("boosts", {}).get("active", 0)
            )

            token["cto"] = "cto" in [
                x.lower()
                for x in dex.get("labels", [])
            ]

            dex_mc = dex.get("marketCap") or dex.get("fdv")

            if dex_mc:
                token["mc"] = dex_mc

            price = dex.get("priceUsd")

            if price:
                token["price"] = float(price)

        return token


# ───────────────── MESSAGE BUILDER ─────────────────


def build_message(ca, token, caller):

    name = token.get("name", "Unknown")
    symbol = token.get("symbol", "?")

    mc = token.get("mc")

    liquidity = token.get("liquidity")

    volume = token.get("volume")

    holders = token.get("holders")

    pre_dex = token.get("pre_dex", False)

    dex_paid = token.get("dex_paid", False)

    cto = token.get("cto", False)

    text = f"""
🪙 <b>{name} (${symbol})</b>

💰 MC: <b>{fmt_usd(mc)}</b>
💧 Liquidity: <b>{fmt_usd(liquidity)}</b>
📈 Volume 24h: <b>{fmt_usd(volume)}</b>
👥 Holders: <b>{holders if holders else 'N/A'}</b>

{'⚡ <b>Pre-DEX Pump.fun</b>' if pre_dex else ''}

Dex Paid: {'✅' if dex_paid else '❌'}
CTO: {'✅' if cto else '❌'}

🏅 Called by {caller}

<code>{ca}</code>
"""

    return text.strip()


# ───────────────── HANDLER ─────────────────


async def handle_message(update: Update, context):

    msg = update.message

    if not msg or not msg.text:
        return

    matches = CA_PATTERN.findall(msg.text)

    if not matches:
        return

    ca = matches[0]

    # ── CHECK EXISTING ──

    async with aiosqlite.connect(DB_FILE) as db:

        cursor = await db.execute(
            "SELECT * FROM calls WHERE ca=?",
            (ca,)
        )

        existing = await cursor.fetchone()

    if existing:

        entry_price = existing[5]
        current_price = existing[6]

        mult = current_price / entry_price

        await msg.reply_text(
            f"⚠️ Already called by {existing[4]}\n"
            f"📈 Currently at {fmt_x(mult)}",
            parse_mode="HTML"
        )

        return

    thinking = await msg.reply_text("🔍 Fetching token...")

    token = await fetch_token(ca)

    if not token:

        await thinking.edit_text(
            "❌ Token not found."
        )

        return

    caller = get_caller(msg.from_user)

    text = build_message(ca, token, caller)

    keyboard = InlineKeyboardMarkup([

        [
            InlineKeyboardButton(
                "📈 Dex",
                url=f"https://dexscreener.com/solana/{ca}"
            ),

            InlineKeyboardButton(
                "⚡ Photon",
                url=f"https://photon-sol.tinyastro.io/en/lp/{ca}"
            )
        ],

        [
            InlineKeyboardButton(
                "🐂 BullX",
                url=f"https://bullx.io/terminal?chainId=1399811149&address={ca}"
            )
        ]
    ])

    await thinking.delete()

    image = token.get("image")

    try:

        if image:

            await msg.reply_photo(
                photo=image,
                caption=text,
                parse_mode="HTML",
                reply_markup=keyboard
            )

        else:

            await msg.reply_text(
                text=text,
                parse_mode="HTML",
                reply_markup=keyboard
            )

    except:

        await msg.reply_text(
            text=text,
            parse_mode="HTML",
            reply_markup=keyboard
        )

    # ── SAVE ──

    price = token.get("price") or 0

    mc = token.get("mc") or 0

    async with aiosqlite.connect(DB_FILE) as db:

        await db.execute("""
        INSERT INTO calls (
            ca,
            chat_id,
            name,
            symbol,
            caller,
            entry_price,
            current_price,
            entry_mc,
            current_mc,
            milestones,
            created_at,
            active
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            ca,
            msg.chat_id,
            token.get("name"),
            token.get("symbol"),
            caller,
            price,
            price,
            mc,
            mc,
            json.dumps([]),
            datetime.now(SYDNEY_TZ).isoformat(),
            1
        ))

        await db.commit()


# ───────────────── PRICE MONITOR ─────────────────


async def monitor_prices(app):

    while True:

        await asyncio.sleep(CHECK_INTERVAL)

        async with aiosqlite.connect(DB_FILE) as db:

            cursor = await db.execute(
                "SELECT * FROM calls WHERE active=1"
            )

            rows = await cursor.fetchall()

        for row in rows:

            ca = row[0]

            token = await fetch_token(ca)

            if not token:
                continue

            current_price = token.get("price")

            current_mc = token.get("mc")

            if not current_price:
                continue

            entry_price = row[5]

            multiplier = current_price / entry_price

            milestones = json.loads(row[9])

            # ── UPDATE ──

            async with aiosqlite.connect(DB_FILE) as db:

                await db.execute("""
                UPDATE calls
                SET current_price=?,
                    current_mc=?
                WHERE ca=?
                """, (
                    current_price,
                    current_mc,
                    ca
                ))

                await db.commit()

            # ── ALERTS ──

            for m in MILESTONES:

                if multiplier >= m and m not in milestones:

                    milestones.append(m)

                    async with aiosqlite.connect(DB_FILE) as db:

                        await db.execute("""
                        UPDATE calls
                        SET milestones=?
                        WHERE ca=?
                        """, (
                            json.dumps(milestones),
                            ca
                        ))

                        await db.commit()

                    alert = f"""
🚀 <b>{row[2]} (${row[3]}) HIT {m}x</b>

🏅 Called by {row[4]}

💰 Entry MC: <b>{fmt_usd(row[7])}</b>
📈 Current MC: <b>{fmt_usd(current_mc)}</b>

<code>{ca}</code>
"""

                    try:

                        await app.bot.send_message(
                            chat_id=row[1],
                            text=alert.strip(),
                            parse_mode="HTML"
                        )

                    except:
                        pass


# ───────────────── STARTUP ─────────────────


async def post_init(app):

    asyncio.create_task(
        monitor_prices(app)
    )


async def start():

    await init_db()

    app = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    app.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            handle_message
        )
    )

    print("✅ Solana Alpha Bot Running")

    await app.run_polling()


if __name__ == "__main__":

    asyncio.run(start())
