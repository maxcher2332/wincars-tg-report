/**
 * Wincars Telegram bot — webhook-based server (multi-office).
 *
 * Listens for /report, /top, /me, /wola, /mokotow, /help, /start commands
 * and replies with sales data from multiple Google Sheets.
 *
 * Required env vars (Render → Environment):
 *   BOT_TOKEN      — Telegram bot token from @BotFather
 *   ALLOWED_CHATS  — comma-separated list of allowed chat ids (e.g. "385330400")
 * Optional:
 *   TIMEZONE       — IANA tz, default "Europe/Warsaw"
 *   WEBHOOK_SECRET — extra guard for /setup-webhook (default "wincars-setup")
 *   WOLA_CSV_URL, MOKOTOW_CSV_URL — override hardcoded URLs if needed
 */

import express from "express";
import { parse as csvParse } from "csv-parse/sync";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHATS = (process.env.ALLOWED_CHATS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const TIMEZONE = process.env.TIMEZONE || "Europe/Warsaw";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "wincars-setup";

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env var.");
  process.exit(1);
}

/* =============================================================
   OFFICES — add new offices here, that's it.
   ============================================================= */
const OFFICES = [
  {
    key: "wola",
    name: "Wola",
    emoji: "🏢",
    csvUrl:
      process.env.WOLA_CSV_URL && process.env.WOLA_CSV_URL.startsWith("https://")
        ? process.env.WOLA_CSV_URL
        : "https://docs.google.com/spreadsheets/d/e/2PACX-1vQZiV2qtlydfMCH2xyqBlomBxTjjGzu9eqVae65xRfr38q9cZ8h7WKsVxXg8gQuX1kz7M1S_YUSC53H/pub?gid=1396698544&single=true&output=csv"
  },
  {
    key: "mokotow",
    name: "Mokotów",
    emoji: "🏬",
    csvUrl:
      process.env.MOKOTOW_CSV_URL && process.env.MOKOTOW_CSV_URL.startsWith("https://")
        ? process.env.MOKOTOW_CSV_URL
        : "https://docs.google.com/spreadsheets/d/e/2PACX-1vRUNFroZNbEKHlABHcQl0ITUACh-5_XHtWlqw5IwXfZiWCOPz1REqqkuXMohpr7-wS8N_yPRjHSTYg-/pub?gid=0&single=true&output=csv"
  }
];

console.log("▶ Configured offices:");
OFFICES.forEach(o => console.log(`   - ${o.name} (${o.key}): ${o.csvUrl}`));

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
async function fetchOffice(office) {
  const r = await fetch(office.csvUrl);
  if (!r.ok) throw new Error(`CSV fetch failed for ${office.name}: HTTP ${r.status}`);
  const csv = await r.text();
  const rows = csvParse(csv, { skip_empty_lines: false, relax_column_count: true });

  let headerIdx = rows.findIndex(rr => rr.some(c => isHeaderRow(c || "")));
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
      completion: (row[4] || "").trim(),
      office: office.name
    });
  }
  return { office, managers, total };
}

async function fetchAllOffices() {
  return Promise.all(OFFICES.map(fetchOffice));
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
function formatManagersTable(managers) {
  const maxName = Math.max(...managers.map(m => m.name.length), 4);
  let block = `<pre>${padR("Имя", maxName)}  Деп Прод План    %\n`;
  managers.forEach(m => {
    const tag = m.sales > m.plan ? " 🔥" : "";
    block += `${padR(m.name, maxName)}  ${padL(m.deposits, 3)} ${padL(m.sales, 4)} ${padL(m.plan, 4)}  ${padL(m.completion, 7)}${tag}\n`;
  });
  block += `</pre>`;
  return block;
}

function avg(num, count) {
  if (!count) return "0";
  return (num / count).toFixed(1).replace(".", ",");
}

function buildOfficeSection({ office, managers, total }) {
  let s = `${office.emoji} <b>${escHtml(office.name)}</b>\n`;
  s += formatManagersTable(managers) + "\n";
  if (total) {
    const pcts = managers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
    const meanPct = pcts.length ? (pcts.reduce((sum, p) => sum + p, 0) / pcts.length).toFixed(2).replace(".", ",") + "%" : "—";
    const conv = total.deposits > 0 ? (total.sales / total.deposits).toFixed(2).replace(".", ",") : "—";
    s += `💵 Депозиты: <b>${total.deposits}</b> · 🚗 Продажи: <b>${total.sales}</b> / ${total.plan} · 🎯 <b>${escHtml(total.completion)}</b>\n`;
    s += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
    s += `📈 Средний % по менеджерам: <b>${meanPct}</b>\n`;
    s += `🔄 Конверсия: <b>${conv}</b> продаж на депозит\n`;
  }
  return s;
}

function buildCombinedReport(allData) {
  const { date, time } = nowParts();
  let msg = `📊 <b>Отчёт по всем офисам</b>\n📅 ${date}  ⏰ ${time}\n━━━━━━━━━━━━━━━━━━\n\n`;

  // Top-3 across all
  const allManagers = allData.flatMap(d => d.managers);
  const top3 = [...allManagers].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  if (top3.length) {
    msg += `🏆 <b>ТОП-3 (вся компания):</b>\n`;
    top3.forEach((m, i) => {
      msg += `${medals[i]} ${escHtml(m.name)} <i>(${escHtml(m.office)})</i> — <b>${m.sales}</b> продаж (${escHtml(m.completion)})\n`;
    });
    msg += "\n";
  }

  // Each office
  allData.forEach(d => {
    msg += buildOfficeSection(d) + "\n";
  });

  // Grand total
  const totalDeposits = allData.reduce((s, d) => s + (d.total?.deposits || 0), 0);
  const totalSales = allData.reduce((s, d) => s + (d.total?.sales || 0), 0);
  const totalPlan = allData.reduce((s, d) => s + (d.total?.plan || 0), 0);
  const grandPct = totalPlan > 0 ? ((totalSales / totalPlan) * 100).toFixed(2) + "%" : "—";
  const totalManagers = allManagers.length;
  const numOffices = allData.length;

  // Mean of individual managers' completion percentages (unweighted)
  const completionPercents = allManagers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
  const meanCompletion = completionPercents.length
    ? (completionPercents.reduce((s, p) => s + p, 0) / completionPercents.length).toFixed(2).replace(".", ",") + "%"
    : "—";

  const grandConv = totalDeposits > 0 ? (totalSales / totalDeposits).toFixed(2).replace(".", ",") : "—";

  msg += `📈 <b>ВСЕГО ПО КОМПАНИИ:</b>\n`;
  msg += `💵 Депозиты: <b>${totalDeposits}</b>\n`;
  msg += `🚗 Продажи: <b>${totalSales}</b> / ${totalPlan}\n`;
  msg += `🎯 Выполнение: <b>${grandPct.replace(".", ",")}</b>\n`;
  msg += `📊 Среднее на менеджера: <b>${avg(totalSales, totalManagers)}</b> прод · <b>${avg(totalDeposits, totalManagers)}</b> деп · 👥 ${totalManagers} мен.\n`;
  msg += `🏢 Среднее на офис: <b>${avg(totalSales, numOffices)}</b> прод · <b>${avg(totalDeposits, numOffices)}</b> деп · ${numOffices} офисов\n`;
  msg += `📈 Средний % по менеджерам: <b>${meanCompletion}</b>\n`;
  msg += `🔄 Конверсия: <b>${grandConv}</b> продаж на депозит\n`;
  return msg;
}

function buildSingleOfficeReport({ office, managers, total }) {
  const { date, time } = nowParts();
  const top3 = [...managers].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];

  let msg = `${office.emoji} <b>${escHtml(office.name)}</b>\n📅 ${date}  ⏰ ${time}\n━━━━━━━━━━━━━━━━━━\n\n`;
  if (top3.length) {
    msg += `🏆 <b>ТОП-3:</b>\n`;
    top3.forEach((m, i) => {
      msg += `${medals[i]} ${escHtml(m.name)} — <b>${m.sales}</b> продаж (${escHtml(m.completion)})\n`;
    });
    msg += "\n";
  }
  msg += `👥 <b>Все менеджеры:</b>\n` + formatManagersTable(managers) + "\n";
  if (total) {
    const completionPercents = managers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
    const meanCompletion = completionPercents.length
      ? (completionPercents.reduce((s, p) => s + p, 0) / completionPercents.length).toFixed(2).replace(".", ",") + "%"
      : "—";
    const conv = total.deposits > 0 ? (total.sales / total.deposits).toFixed(2).replace(".", ",") : "—";
    msg += `\n📈 <b>ИТОГО ${escHtml(office.name).toUpperCase()}:</b>\n`;
    msg += `💵 Депозиты: <b>${total.deposits}</b>\n`;
    msg += `🚗 Продажи: <b>${total.sales}</b> / ${total.plan}\n`;
    msg += `🎯 Выполнение: <b>${escHtml(total.completion)}</b>\n`;
    msg += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
    msg += `📈 Средний % по менеджерам: <b>${meanCompletion}</b>\n`;
    msg += `🔄 Конверсия: <b>${conv}</b> продаж на депозит\n`;
  }
  return msg;
}

function buildCombinedTop(allData) {
  const all = allData.flatMap(d => d.managers);
  const top = [...all].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const { date, time } = nowParts();
  let msg = `🏆 <b>ТОП-3 по компании</b>\n📅 ${date}  ⏰ ${time}\n\n`;
  top.forEach((m, i) => {
    msg += `${medals[i]} <b>${escHtml(m.name)}</b> <i>(${escHtml(m.office)})</i>\n`;
    msg += `   🚗 ${m.sales} продаж · 💵 ${m.deposits} депозитов · 🎯 ${escHtml(m.completion)}\n\n`;
  });
  return msg;
}

function buildSearchAcrossOffices(allData, query) {
  const q = query.toLowerCase();
  const all = allData.flatMap(d => d.managers);
  const exact = all.filter(m => m.name.toLowerCase() === q);
  const partial = all.filter(m => m.name.toLowerCase().includes(q));
  const matches = exact.length ? exact : partial;

  if (!matches.length) {
    const list = all.map(m => `• ${m.name} (${m.office})`).join("\n");
    return `❓ Не нашёл «${escHtml(query)}». Все менеджеры:\n\n${escHtml(list)}`;
  }

  const { date, time } = nowParts();
  let msg = `🔎 <b>Найдено: ${matches.length}</b>\n📅 ${date}  ⏰ ${time}\n\n`;
  matches.forEach(m => {
    msg += `👤 <b>${escHtml(m.name)}</b> <i>(${escHtml(m.office)})</i>\n`;
    msg += `   💵 Депозиты: <b>${m.deposits}</b>\n`;
    msg += `   🚗 Продажи: <b>${m.sales}</b> / ${m.plan}\n`;
    msg += `   🎯 Выполнение: <b>${escHtml(m.completion)}</b>`;
    if (m.sales > m.plan) msg += ` 🔥`;
    msg += `\n\n`;
  });
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
  `/report — отчёт по всем офисам\n` +
  `/wola — только офис Wola\n` +
  `/mokotow — только офис Mokotów\n` +
  `/top — топ-3 по компании\n` +
  `/me &lt;имя&gt; — поиск по имени (по обоим офисам)\n` +
  `/help — эта подсказка`;

/* =============================================================
   Routes
   ============================================================= */
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);
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
      const all = await fetchAllOffices();
      await tgSend(chatId, buildCombinedReport(all));
    } else if (cmd === "/wola" || cmd === "/office1") {
      const office = OFFICES.find(o => o.key === "wola");
      const data = await fetchOffice(office);
      await tgSend(chatId, buildSingleOfficeReport(data));
    } else if (cmd === "/mokotow" || cmd === "/mokotów" || cmd === "/office2") {
      const office = OFFICES.find(o => o.key === "mokotow");
      const data = await fetchOffice(office);
      await tgSend(chatId, buildSingleOfficeReport(data));
    } else if (cmd === "/top") {
      const all = await fetchAllOffices();
      await tgSend(chatId, buildCombinedTop(all));
    } else if (cmd === "/me") {
      const arg = text.replace(/^\/me\s*/i, "").trim();
      if (!arg) {
        await tgSend(chatId, "Использование: <code>/me Имя</code>\nНапример: <code>/me Daniel</code>");
      } else {
        const all = await fetchAllOffices();
        await tgSend(chatId, buildSearchAcrossOffices(all, arg));
      }
    } else {
      await tgSend(chatId, `🤔 Не понимаю команду <code>${escHtml(cmd)}</code>.\n\n` + HELP_TEXT);
    }
  } catch (err) {
    console.error("[TG webhook] error:", err);
    try {
      const chatId = String(req.body?.message?.chat?.id || "");
      if (chatId) await tgSend(chatId, `❌ Ошибка: ${escHtml(err.message)}`);
    } catch {}
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
    offices: OFFICES.map(o => ({ key: o.key, name: o.name })),
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
  console.log(`   Offices: ${OFFICES.map(o => o.name).join(", ")} · Allowed: ${ALLOWED_CHATS.join(",") || "none"} · TZ: ${TIMEZONE}`);
});
