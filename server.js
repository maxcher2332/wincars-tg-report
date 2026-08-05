/**
 * Wincars Telegram bot — webhook-based server (multi-office).
 * Offices: Wola, Mokotów.
 * Metrics: averages + daily plan progress (NO conversion).
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
  },
  {
    key: "mokotow2",
    name: "Mokotów 2.0",
    emoji: "🏪",
    csvUrl:
      process.env.MOKOTOW2_CSV_URL && process.env.MOKOTOW2_CSV_URL.startsWith("https://")
        ? process.env.MOKOTOW2_CSV_URL
        : "https://docs.google.com/spreadsheets/d/1rGpO9MS49dmx8071wfhC5Nel9n9YLjVuGU05khQ7ulc/gviz/tq?tqx=out:csv&gid=0"
  }
];

console.log("▶ Configured offices:", OFFICES.map(o => o.name).join(", "));

app.use(express.json());

/* ===== helpers ===== */
const intOnly = v => {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
};
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const padR = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");
const avg = (n, c) => !c ? "0" : (n / c).toFixed(1).replace(".", ",");
const pct = (s, p) => p > 0 ? `${((s / p) * 100).toFixed(2).replace(".", ",")}%` : "—";

const isDateRow = name => /^\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(name);
const isTotalRow = name => /общий|итог|total|razem/i.test(name || "");
const isHeaderRow = name => /имя|name|менеджер|manager|imię|imie/i.test(name || "");

/* ===== CSV fetch & parse ===== */
async function fetchOffice(office) {
  // Cache-busting: добавляем метку времени, чтобы Google не отдавал закешированную версию
  const sep = office.csvUrl.includes("?") ? "&" : "?";
  const freshUrl = `${office.csvUrl}${sep}_t=${Date.now()}`;
  const r = await fetch(freshUrl, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache" }
  });
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
  // Используем allSettled чтобы падение одного офиса не роняло весь отчёт
  const results = await Promise.allSettled(OFFICES.map(fetchOffice));
  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    console.error(`[fetchAllOffices] ${OFFICES[i].name} failed:`, r.reason?.message);
    return {
      office: OFFICES[i],
      managers: [],
      total: null,
      error: r.reason?.message || "Unknown error"
    };
  });
}

function nowParts() {
  const d = new Date();
  return {
    date: d.toLocaleDateString("ru-RU", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric" }),
    time: d.toLocaleTimeString("ru-RU", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" })
  };
}

/* ===== Daily plan progress ===== */
function todayInTz() {
  // Get current Y-M-D in the configured timezone
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

function dailyPlanProgress(totalPlan, totalSales) {
  const { year, month, day } = todayInTz();
  const daysInMonth = new Date(year, month, 0).getDate(); // last day of `month`
  const expectedFraction = day / daysInMonth;
  const expectedSales = totalPlan * expectedFraction;
  const expectedRounded = Math.round(expectedSales);
  const delta = totalSales - expectedRounded;
  const ahead = delta >= 0;

  return {
    day,
    daysInMonth,
    monthProgressPct: (expectedFraction * 100).toFixed(0) + "%",
    expectedSales: expectedRounded,
    actualSales: totalSales,
    delta,
    ahead,
    emoji: ahead ? "🚀" : "⚠️",
    msg: ahead
      ? `впереди графика на <b>${delta}</b> продаж ${ahead ? "🚀" : ""}`
      : `позади графика на <b>${-delta}</b> продаж ⚠️`
  };
}

function formatDailyPlanLines(totalPlan, totalSales) {
  if (!totalPlan) return "";
  const p = dailyPlanProgress(totalPlan, totalSales);
  let s = "";
  s += `📅 День ${p.day} из ${p.daysInMonth} (${p.monthProgressPct} месяца)\n`;
  s += `🎯 План на сегодня: <b>${p.expectedSales}</b> продаж (из ${totalPlan})\n`;
  s += `🚗 Факт: <b>${p.actualSales}</b> · ${p.msg}\n`;
  return s;
}

/* Monthly plan calendar — day-by-day breakdown with ✅ / 📌 / ⏳ markers */
const MONTH_NAMES_RU = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря"
];

function buildMonthlyPlanCalendar(allData) {
  const { year, month, day: today } = todayInTz();
  const daysInMonth = new Date(year, month, 0).getDate();
  const officesWithPlans = allData.filter(d => d.total?.plan);
  if (!officesWithPlans.length) return "";

  // Текущие совокупные продажи по всей компании
  const totalCurrentSales = officesWithPlans.reduce((s, d) => s + (d.total.sales || 0), 0);

  const officeCols = officesWithPlans.map(({ office }) => ({
    label: office.name.length > 6 ? office.name.slice(0, 6) : office.name,
    fullName: office.name
  }));

  let s = `\n📆 <b>План по дням ${MONTH_NAMES_RU[month - 1]}:</b>\n<pre>`;
  s += `Дата   `;
  officeCols.forEach(c => { s += padL(c.label, 7); });
  s += padL("Σ", 6) + "  Статус\n";

  for (let d = 1; d <= daysInMonth; d++) {
    const fraction = d / daysInMonth;
    const dateStr = `${String(d).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
    let totalForDay = 0;
    let line = `${dateStr} `;
    officesWithPlans.forEach(({ office, total }) => {
      const target = Math.round(total.plan * fraction);
      totalForDay += target;
      line += padL(String(target), 7);
    });
    line += padL(String(totalForDay), 6) + "  ";

    // ✅ если общая сумма продаж по компании уже покрывает план этого дня
    let icon;
    if (d < today) {
      icon = totalCurrentSales >= totalForDay ? "✅" : "⛔";
    } else if (d === today) {
      icon = totalCurrentSales >= totalForDay ? "📌 сегодня ✅" : "📌 сегодня";
    } else {
      icon = "⏳";
    }
    line += icon + "\n";
    s += line;
  }
  s += `</pre>`;
  return s;
}

/* ===== Message builders ===== */
function meanPercent(managers) {
  const pcts = managers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
  return pcts.length ? (pcts.reduce((s, p) => s + p, 0) / pcts.length).toFixed(2).replace(".", ",") + "%" : "—";
}

function formatManagersTable(managers) {
  // Санитайзер для содержимого <pre> — убираем HTML-опасные символы и невидимые unicode
  const cleanCell = s => String(s ?? "")
    .replace(/[<>&]/g, "")             // символы, ломающие HTML-разметку Telegram
    .replace(/[​-‍﻿]/g, "") // zero-width и BOM
    .trim();

  const cleaned = managers.map(m => ({
    ...m,
    name: cleanCell(m.name),
    completion: cleanCell(m.completion)
  }));

  const maxName = Math.max(...cleaned.map(m => m.name.length), 4);
  let block = `<pre>${padR("Имя", maxName)}  Деп Прод План    %\n`;
  cleaned.forEach(m => {
    const tag = m.sales > m.plan && m.plan > 0 ? " 🔥" : "";
    block += `${padR(m.name, maxName)}  ${padL(m.deposits, 3)} ${padL(m.sales, 4)} ${padL(m.plan, 4)}  ${padL(m.completion, 7)}${tag}\n`;
  });
  block += `</pre>`;
  return block;
}

function buildOfficeSection({ office, managers, total }) {
  let s = `${office.emoji} <b>${escHtml(office.name)}</b>\n`;
  s += formatManagersTable(managers) + "\n";
  if (total) {
    s += `💵 Депозиты: <b>${total.deposits}</b> · 🚗 Продажи: <b>${total.sales}</b> / ${total.plan} · 🎯 <b>${escHtml(total.completion)}</b>\n`;
    s += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
    s += `📈 Средний % по менеджерам: <b>${meanPercent(managers)}</b>\n`;
    s += formatDailyPlanLines(total.plan, total.sales);
  }
  return s;
}

function buildCombinedReport(allData) {
  const { date, time } = nowParts();
  let msg = `📊 <b>Отчёт по всем офисам</b>\n📅 ${date}  ⏰ ${time}\n━━━━━━━━━━━━━━━━━━\n\n`;

  // Показываем предупреждение про отвалившиеся офисы
  const failed = allData.filter(d => d.error);
  if (failed.length) {
    msg += `⚠️ <b>Не удалось получить данные:</b>\n`;
    failed.forEach(d => {
      msg += `• ${escHtml(d.office.name)} — ${escHtml(d.error)}\n`;
    });
    msg += `\n`;
  }

  // Работаем только с успешно загруженными офисами
  allData = allData.filter(d => !d.error);
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

  allData.forEach(d => { msg += buildOfficeSection(d) + "\n"; });

  const totalDeposits = allData.reduce((s, d) => s + (d.total?.deposits || 0), 0);
  const totalSales    = allData.reduce((s, d) => s + (d.total?.sales || 0), 0);
  const totalPlan     = allData.reduce((s, d) => s + (d.total?.plan || 0), 0);
  const totalManagers = allManagers.length;
  const numOffices    = allData.length;

  const completionPercents = allManagers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
  const meanCompletion = completionPercents.length
    ? (completionPercents.reduce((s, p) => s + p, 0) / completionPercents.length).toFixed(2).replace(".", ",") + "%"
    : "—";

  msg += `📈 <b>ВСЕГО ПО КОМПАНИИ:</b>\n`;
  msg += `💵 Депозиты: <b>${totalDeposits}</b>\n`;
  msg += `🚗 Продажи: <b>${totalSales}</b> / ${totalPlan}\n`;
  msg += `🎯 Выполнение: <b>${pct(totalSales, totalPlan)}</b>\n`;
  msg += `📊 Среднее на менеджера: <b>${avg(totalSales, totalManagers)}</b> прод · <b>${avg(totalDeposits, totalManagers)}</b> деп · 👥 ${totalManagers} мен.\n`;
  msg += `🏢 Среднее на офис: <b>${avg(totalSales, numOffices)}</b> прод · <b>${avg(totalDeposits, numOffices)}</b> деп · ${numOffices} офисов\n`;
  msg += `📈 Средний % по менеджерам: <b>${meanCompletion}</b>\n`;
  msg += formatDailyPlanLines(totalPlan, totalSales);
  msg += buildMonthlyPlanCalendar(allData);
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
    msg += `\n📈 <b>ИТОГО ${escHtml(office.name).toUpperCase()}:</b>\n`;
    msg += `💵 Депозиты: <b>${total.deposits}</b>\n`;
    msg += `🚗 Продажи: <b>${total.sales}</b> / ${total.plan}\n`;
    msg += `🎯 Выполнение: <b>${escHtml(total.completion)}</b>\n`;
    msg += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
    msg += `📈 Средний % по менеджерам: <b>${meanPercent(managers)}</b>\n`;
    msg += formatDailyPlanLines(total.plan, total.sales);
    msg += buildMonthlyPlanCalendar([{ office, managers, total }]);
  }
  return msg;
}

function buildCombinedTop(allData) {
  const all = allData.flatMap(d => d.managers);
  const top = [...all].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  const { date, time } = nowParts();
  let msg = `🏆 <b>Топ-3 менеджеров</b>\n📅 ${date}  ⏰ ${time}\n\n`;
  top.forEach((m, i) => {
    msg += `${medals[i]} <b>${escHtml(m.name)}</b> <i>(${escHtml(m.office)})</i>\n`;
    msg += `   🚗 ${m.sales} продаж · 💵 ${m.deposits} депозитов · 🎯 ${escHtml(m.completion)}\n\n`;
  });
  return msg;
}

function buildIndividualReport(allData, query) {
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
    if (m.sales > m.plan && m.plan > 0) msg += ` 🔥`;
    msg += `\n\n`;
  });
  return msg;
}

/* ===== Telegram API ===== */
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
  `/mokotow — только Mokotów\n` +
  `/mokotow2 — только Mokotów 2.0\n` +
  `/top — топ-3 по компании\n` +
  `/me &lt;имя&gt; — поиск по имени\n` +
  `/help — эта подсказка`;

/* ===== Routes ===== */
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
    } else if (cmd === "/mokotow2" || cmd === "/mok2" || cmd === "/office3") {
      const office = OFFICES.find(o => o.key === "mokotow2");
      const data = await fetchOffice(office);
      await tgSend(chatId, buildSingleOfficeReport(data));
    } else if (cmd === "/top") {
      const all = await fetchAllOffices();
      await tgSend(chatId, buildCombinedTop(all));
    } else if (cmd === "/me") {
      const arg = text.replace(/^\/me\s*/i, "").trim();
      if (!arg) await tgSend(chatId, "Использование: <code>/me Имя</code>\nНапример: <code>/me Daniel</code>");
      else {
        const all = await fetchAllOffices();
        await tgSend(chatId, buildIndividualReport(all, arg));
      }
    } else {
      await tgSend(chatId, `🤔 Не понимаю команду <code>${escHtml(cmd)}</code>.\n\n` + HELP_TEXT);
    }
  } catch (err) {
    console.error("[TG webhook] error:", err);
    try {
      const chatId = String(req.body?.message?.chat?.id || "");
      if (chatId) {
        await tgSend(chatId, `❌ Ошибка сервера: <code>${escHtml(err.message)}</code>\n\nПопробуйте через минуту или напишите админу.`);
      }
    } catch { /* ignore */ }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    bot: BOT_TOKEN ? "configured" : "missing BOT_TOKEN",
    allowedChats: ALLOWED_CHATS,
    timezone: TIMEZONE
  });
});

app.listen(PORT, () => {
  console.log(`✅ Wincars bot listening on :${PORT} · TZ: ${TIMEZONE}`);
});
