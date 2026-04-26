/**
 * Wincars Telegram bot — webhook-based server.
 *
 * Listens for /report, /top, /me, /help, /start commands from Telegram users
 * and replies with sales data fetched from a Google Sheet (CSV).
 *
 * Required env vars (Render → Environment):
 *   BOT_TOKEN      — Telegram bot token from @BotFather
 *   CSV_URL        — public Google Sheet CSV link
 *   ALLOWED_CHATS  — comma-separated list of allowed chat ids (e.g. "385330400")
 * Optional:
 *   TIMEZONE       — IANA tz, default "Europe/Warsaw"
 *   WEBHOOK_SECRET — extra guard for /setup-webhook (default "wincars-setup")
 *   PORT           — set automatically by Render
 */

import express from "express";
import { parse as csvParse } from "csv-parse/sync";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
// CSV URL — hardcoded fallback so we don't depend on env var copy-paste.
// Override via env var if you need to point to a different sheet.
const DEFAULT_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQZiV2qtlydfMCH2xyqBlomBxTjjGzu9eqVae65xRfr38q9cZ8h7WKsVxXg8gQuX1kz7M1S_YUSC53H/pub?gid=1396698544&single=true&output=csv";
const CSV_URL = (process.env.CSV_URL && process.env.CSV_URL.startsWith("https://")) ? process.env.CSV_URL : DEFAULT_CSV_URL;
const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TIMEZONE = process.env.TIMEZONE || "Europe/Warsaw";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "wincars-setup";

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env var.");
  process.exit(1);
}
console.log(`▶ CSV_URL in use: ${CSV_URL}`);

app.use(express.json());

/* =============================================================
   Helpers
   ============================================================= */
const intOnly = v => {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const padR = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");

const isDateRow = name => /^\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(name);
const isTotalRow = name => /общий|итог|total|razem/i.test(name || "");
const isHeaderRow = name => /имя|name|менеджер|manager|imię|imie/i.test(name || "");

/* =============================================================
   CSV fetch & parse
   ============================================================= */
async function fetchManagers() {
  const r = await fetch(CSV_URL);
  if (!r.ok) throw new Error(`CSV fetch failed: HTTP ${r.status}`);
  const csv = await r.text();
  const rows = csvParse(csv, { skip_empty_lines: false, relax_column_count: true });

  let headerIdx = rows.findIndex(r => r.some(c => isHeaderRow(c || "")));
  if (headerIdx < 0) headerIdx = 1;

  const managers = [];
  let total = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const nm = (row[0] || "").trim();
    if (!nm) continue;

    if (isTotalRow(nm)) {
      total = {
        name: nm,
        deposits: intOnly(row[1]),
        sales: intOnly(row[2]),
        plan: intOnly(row[3]),
        completion: (row[4] || "").trim()
      };
      break;
    }
    if (isHeaderRow(nm) && !intOnly(row[2])) break;
    if (isDateRow(nm)) continue;
    if (!row[1] && !row[2] && !row[3]) continue;

    managers.push({
      name: nm,
      deposits: intOnly(row[1]),
      sales: intOnly(row[2]),
      plan: intOnly(row[3]),
      completion: (row[4] || "").trim()
    });
  }
  return { managers, total };
}

function nowParts() {
  const d = new Date();
  return {
    date: d.toLocaleDateString("ru-RU", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }),
    time: d.toLocaleTimeString("ru-RU", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" })
  };
}

/* =============================================================
   Message builders
   ============================================================= */
function buildFullReport({ managers, total }) {
  const top3 = [...managers].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const { date, time } = nowParts();

  let msg = `📊 <b>Отчёт по менеджерам</b>\n📅 ${date}  ⏰ ${time}\n━━━━━━━━━━━━━━━━━━\n\n`;
  if (top3.length) {
    msg += `🏆 <b>ТОП-3:</b>\n`;
    top3.forEach((m, i) => {
      msg += `${medals[i]} ${escHtml(m.name)} — <b>${m.sales}</b> продаж (${escHtml(m.completion)})\n`;
    });
    msg += "\n";
  }
  const maxName = Math.max(...managers.map(m => m.name.length), 4);
  msg += `👥 <b>Все менеджеры:</b>\n<pre>`;
  msg += `${padR("Имя", maxName)}  Прод План  %\n`;
  managers.forEach(m => {
    const tag = m.sales > m.plan ? " 🔥" : "";
    msg += `${padR(m.name, maxName)}  ${padL(m.sales, 4)} ${padL(m.plan, 4)}  ${padL(m.completion, 7)}${tag}\n`;
  });
  msg += `</pre>\n`;
  if (total) {
    msg += `\n📈 <b>ИТОГО:</b>\n💵 Депозиты: <b>${total.deposits}</b>\n🚗 Продажи: <b>${total.sales}</b> / ${total.plan}\n🎯 Выполнение: <b>${escHtml(total.completion)}</b>\n`;
  }
  return msg;
}

function buildTopReport({ managers }) {
  const top3 = [...managers].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const { date, time } = nowParts();
  let msg = `🏆 <b>Топ-3 менеджеров</b>\n📅 ${date}  ⏰ ${time}\n\n`;
  top3.forEach((m, i) => {
    msg += `${medals[i]} <b>${escHtml(m.name)}</b>\n`;
    msg += `   🚗 ${m.sales} продаж · 💵 ${m.deposits} депозитов · 🎯 ${escHtml(m.completion)}\n\n`;
  });
  return msg;
}

function buildIndividualReport({ managers }, query) {
  const q = query.toLowerCase();
  const found = managers.find(m => m.name.toLowerCase() === q)
             || managers.find(m => m.name.toLowerCase().includes(q));
  if (!found) {
    const list = managers.map(m => "• " + m.name).join("\n");
    return `❓ Не нашёл менеджера «${escHtml(query)}». Попробуй точнее или одно из:\n\n${escHtml(list)}`;
  }
  const { date, time } = nowParts();
  let msg = `👤 <b>${escHtml(found.name)}</b>\n📅 ${date}  ⏰ ${time}\n\n`;
  msg += `💵 Депозиты: <b>${found.deposits}</b>\n`;
  msg += `🚗 Продажи: <b>${found.sales}</b> / ${found.plan}\n`;
  msg += `🎯 Выполнение: <b>${escHtml(found.completion)}</b>\n`;
  if (found.sales > found.plan) msg += `\n🔥 План перевыполнен!`;
  return msg;
}

/* =============================================================
   Telegram API
   ============================================================= */
async function tgSend(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const j = await r.json();
  if (!j.ok) console.error("[TG sendMessage]", j);
  return j;
}

const HELP_TEXT =
  `📚 <b>Команды:</b>\n` +
  `/report — полный отчёт по всем\n` +
  `/top — топ-3 менеджеров\n` +
  `/me &lt;имя&gt; — отчёт по конкретному менеджеру\n` +
  `/help — эта подсказка`;

/* =============================================================
   Routes
   ============================================================= */
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200); // ack right away
  try {
    const update = req.body || {};
    const message = update.message || update.edited_message || update.channel_post;
    if (!message || !message.text) return;

    const chatId = String(message.chat.id);
    const text = message.text.trim();
    const fromName = message.from?.first_name || "";

    if (ALLOWED_CHATS.length && !ALLOWED_CHATS.includes(chatId)) {
      console.log(`[TG] Ignoring message from non-allowed chat ${chatId}`);
      await tgSend(chatId, "⛔️ У вас нет доступа к этому боту.");
      return;
    }
    console.log(`[TG] ${chatId} (${fromName}): ${text}`);

    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, "");

    if (cmd === "/start") {
      await tgSend(chatId, `👋 Привет, ${escHtml(fromName)}!\n\nЯ бот <b>Wincars Sales</b>.\n\n` + HELP_TEXT);
    } else if (cmd === "/help") {
      await tgSend(chatId, HELP_TEXT);
    } else if (cmd === "/report") {
      const data = await fetchManagers();
      await tgSend(chatId, buildFullReport(data));
    } else if (cmd === "/top") {
      const data = await fetchManagers();
      await tgSend(chatId, buildTopReport(data));
    } else if (cmd === "/me") {
      const arg = text.replace(/^\/me\s*/i, "").trim();
      if (!arg) {
        await tgSend(chatId, "Использование: <code>/me Имя</code>\nНапример: <code>/me Daniel</code>");
      } else {
        const data = await fetchManagers();
        await tgSend(chatId, buildIndividualReport(data, arg));
      }
    } else {
      await tgSend(chatId, `🤔 Не понимаю команду <code>${escHtml(cmd)}</code>.\n\n` + HELP_TEXT);
    }
  } catch (err) {
    console.error("[TG webhook] error:", err);
  }
});

app.get("/setup-webhook", async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    return res.status(401).send(`Forbidden. Append ?secret=${WEBHOOK_SECRET}`);
  }
  const host = req.headers.host;
  const webhookUrl = `https://${host}/telegram-webhook`;
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    res.json({ webhookUrl, telegram: j });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    csv: CSV_URL ? "configured" : "missing",
    bot: BOT_TOKEN ? "configured" : "missing",
    allowedChats: ALLOWED_CHATS,
    timezone: TIMEZONE
  });
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("Wincars Telegram bot is alive ✅\nGo to /health for status.");
});

app.listen(PORT, () => {
  console.log(`✅ Wincars Telegram bot listening on :${PORT}`);
  console.log(`   CSV: ${CSV_URL ? "ON" : "OFF"} · Allowed chats: ${ALLOWED_CHATS.join(",") || "none"} · TZ: ${TIMEZONE}`);
});
