/**
 * Wincars daily sales report — multi-office.
 * Triggered by GitHub Actions cron.
 *
 * Required env vars (GitHub Secrets):
 *   BOT_TOKEN  — Telegram bot token
 *   CHAT_ID    — Telegram chat id to send to
 * Optional:
 *   TIMEZONE   — IANA tz, default "Europe/Warsaw"
 *   WOLA_CSV_URL, MOKOTOW_CSV_URL — override defaults if needed
 */

import { parse as csvParse } from "csv-parse/sync";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID  = process.env.CHAT_ID;
const TIMEZONE = process.env.TIMEZONE || "Europe/Warsaw";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ Missing BOT_TOKEN or CHAT_ID env vars.");
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
  }
];

/* ----- helpers ----- */
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

function formatTable(managers) {
  const maxName = Math.max(...managers.map(m => m.name.length), 4);
  let block = `<pre>${padR("Имя", maxName)}  Деп Прод План    %\n`;
  managers.forEach(m => {
    const tag = m.sales > m.plan ? " 🔥" : "";
    block += `${padR(m.name, maxName)}  ${padL(m.deposits, 3)} ${padL(m.sales, 4)} ${padL(m.plan, 4)}  ${padL(m.completion, 7)}${tag}\n`;
  });
  block += `</pre>`;
  return block;
}

function buildReport(allData) {
  const today = new Date().toLocaleDateString("ru-RU", {
    timeZone: TIMEZONE, day: "2-digit", month: "2-digit", year: "numeric"
  });
  const time = new Date().toLocaleTimeString("ru-RU", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit"
  });

  let msg = `📊 <b>Отчёт по всем офисам</b>\n📅 ${today}  ⏰ ${time}\n━━━━━━━━━━━━━━━━━━\n\n`;

  // Top-3 across all
  const all = allData.flatMap(d => d.managers);
  const top3 = [...all].sort((a, b) => b.sales - a.sales).slice(0, 3);
  const medals = ["🥇", "🥈", "🥉"];
  if (top3.length) {
    msg += `🏆 <b>ТОП-3 (вся компания):</b>\n`;
    top3.forEach((m, i) => {
      msg += `${medals[i]} ${escHtml(m.name)} <i>(${escHtml(m.office)})</i> — <b>${m.sales}</b> продаж (${escHtml(m.completion)})\n`;
    });
    msg += "\n";
  }

  const avg = (n, c) => !c ? "0" : (n / c).toFixed(1).replace(".", ",");

  allData.forEach(({ office, managers, total }) => {
    msg += `${office.emoji} <b>${escHtml(office.name)}</b>\n`;
    msg += formatTable(managers) + "\n";
    if (total) {
      const pcts = managers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
      const meanPct = pcts.length ? (pcts.reduce((s, p) => s + p, 0) / pcts.length).toFixed(2).replace(".", ",") + "%" : "—";
      const conv = total.deposits > 0 ? (total.sales / total.deposits).toFixed(2).replace(".", ",") : "—";
      msg += `💵 Депозиты: <b>${total.deposits}</b> · 🚗 Продажи: <b>${total.sales}</b> / ${total.plan} · 🎯 <b>${escHtml(total.completion)}</b>\n`;
      msg += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
      msg += `📈 Средний % по менеджерам: <b>${meanPct}</b>\n`;
      msg += `🔄 Конверсия: <b>${conv}</b> продаж на депозит\n`;
    }
    msg += "\n";
  });

  // Grand total
  const totalDeposits = allData.reduce((s, d) => s + (d.total?.deposits || 0), 0);
  const totalSales = allData.reduce((s, d) => s + (d.total?.sales || 0), 0);
  const totalPlan = allData.reduce((s, d) => s + (d.total?.plan || 0), 0);
  const totalManagers = allData.reduce((s, d) => s + d.managers.length, 0);
  const numOffices = allData.length;
  const grandPct = totalPlan > 0 ? ((totalSales / totalPlan) * 100).toFixed(2) + "%" : "—";

  // Mean of individual managers' completion percentages (unweighted)
  const allManagersFlat = allData.flatMap(d => d.managers);
  const completionPercents = allManagersFlat.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
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

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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
  console.log(`▶ Fetching ${OFFICES.length} office(s)...`);
  const allData = await Promise.all(OFFICES.map(fetchOffice));
  allData.forEach(d => console.log(`  ${d.office.name}: ${d.managers.length} managers, total=${JSON.stringify(d.total)}`));
  const message = buildReport(allData);
  console.log(`▶ Sending to chat ${CHAT_ID}...`);
  await sendTelegram(message);
  console.log("✅ Done.");
}

main().catch(err => {
  console.error("❌ Failed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
