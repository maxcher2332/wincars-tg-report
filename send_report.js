/**
 * Wincars daily sales report — Telegram bot.
 *
 * Reads a Google Sheet published as CSV, formats a nice summary,
 * and sends it to a Telegram chat via Bot API.
 *
 * Required env vars (set as GitHub Secrets):
 *   CSV_URL    — public Google Sheet CSV link
 *   BOT_TOKEN  — Telegram bot token from @BotFather
 *   CHAT_ID    — Telegram chat id to send to
 *
 * Optional:
 *   TIMEZONE   — IANA tz, default "Europe/Warsaw"
 */

import { parse } from "csv-parse/sync";

const CSV_URL  = process.env.CSV_URL;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID  = process.env.CHAT_ID;
const TIMEZONE = process.env.TIMEZONE || "Europe/Warsaw";

if (!CSV_URL || !BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing env vars: CSV_URL, BOT_TOKEN, CHAT_ID are required.");
  process.exit(1);
}

/* ----- helpers ----- */
const num = v => {
  if (v === null || v === undefined) return 0;
  const cleaned = String(v).replace(/[^\d-]/g, "");
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : 0;
};
const escHtml = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const padR = (s, n) => String(s).padEnd(n, " ");
const padL = (s, n) => String(s).padStart(n, " ");

/* ----- main ----- */
async function fetchCsv() {
  const r = await fetch(CSV_URL);
  if (!r.ok) throw new Error(`Failed to fetch CSV: HTTP ${r.status}`);
  return await r.text();
}

function parseRow(row) {
  return {
    name: (row[0] || "").trim(),
    deposits: num(row[1]),
    sales: num(row[2]),
    plan: num(row[3]),
    completion: (row[4] || "").trim()
  };
}

function isDateRow(name) {
  return /^\s*\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}/.test(name);
}

function isTotalRow(name) {
  const n = name.toLowerCase();
  return n.includes("общий") || n.includes("итог") || n.includes("total") || n.includes("razem");
}

function isHeaderRow(name) {
  return /имя|name|менеджер|manager|imię|imie/i.test(name);
}

function buildMessage(rows) {
  // Find the FIRST header row
  let headerIdx = rows.findIndex(r => r.some(c => isHeaderRow(c || "")));
  if (headerIdx < 0) headerIdx = 1;
  const dataStart = headerIdx + 1;

  const managers = [];
  let total = null;

  for (let i = dataStart; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0] || !row[0].trim()) continue;
    const name = row[0].trim();

    // STOP at the first totals row — anything after is a second block we ignore
    if (isTotalRow(name)) {
      total = parseRow(row);
      break;
    }
    // STOP if we hit a SECOND header row mid-sheet
    if (isHeaderRow(name) && !num(row[2])) break;

    if (isDateRow(name)) continue;
    if (!row[1] && !row[2] && !row[3]) continue;   // skip empty data rows

    managers.push(parseRow(row));
  }

  // Top 3 by sales (descending)
  const top3 = [...managers].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];

  const today = new Date().toLocaleDateString("ru-RU", {
    timeZone: TIMEZONE,
    day: "2-digit", month: "2-digit", year: "numeric"
  });
  const time = new Date().toLocaleTimeString("ru-RU", {
    timeZone: TIMEZONE,
    hour: "2-digit", minute: "2-digit"
  });

  let msg = `📊 <b>Отчёт по менеджерам</b>\n`;
  msg += `📅 ${today}  ⏰ ${time}\n`;
  msg += `━━━━━━━━━━━━━━━━━━\n\n`;

  if (top3.length) {
    msg += `🏆 <b>ТОП-3:</b>\n`;
    top3.forEach((m, i) => {
      msg += `${medals[i]} ${escHtml(m.name)} — <b>${m.sales}</b> продаж (${escHtml(m.completion)})\n`;
    });
    msg += "\n";
  }

  // Find max name length for alignment
  const maxName = Math.max(...managers.map(m => m.name.length), 4);
  msg += `👥 <b>Все менеджеры:</b>\n<pre>`;
  msg += `${padR("Имя", maxName)}  Прод План  %\n`;
  managers.forEach(m => {
    const tag = m.sales > m.plan ? " 🔥" : "";
    msg += `${padR(m.name, maxName)}  ${padL(m.sales, 4)} ${padL(m.plan, 4)}  ${padL(m.completion, 7)}${tag}\n`;
  });
  msg += `</pre>\n`;

  if (total) {
    msg += `\n📈 <b>ИТОГО:</b>\n`;
    msg += `💵 Депозиты: <b>${total.deposits}</b>\n`;
    msg += `🚗 Продажи: <b>${total.sales}</b> / ${total.plan}\n`;
    msg += `🎯 Выполнение: <b>${escHtml(total.completion)}</b>\n`;
  }

  return msg;
}

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram API error: ${JSON.stringify(j)}`);
  console.log(`✅ Sent message_id=${j.result.message_id} to chat ${CHAT_ID}`);
}

async function main() {
  console.log(`▶ Fetching CSV...`);
  const csv = await fetchCsv();
  const rows = parse(csv, { skip_empty_lines: false, relax_column_count: true });
  console.log(`▶ Parsed ${rows.length} rows.`);

  const message = buildMessage(rows);
  console.log("▶ Built message:\n" + message.replace(/<[^>]+>/g, ""));

  console.log(`▶ Sending to Telegram...`);
  await sendTelegram(message);
  console.log(`✅ Done.`);
}

main().catch(err => {
  console.error("❌ Failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
