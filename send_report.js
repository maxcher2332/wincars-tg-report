/**
 * Wincars daily sales report — multi-office (Wola + Mokotów).
 * Triggered by GitHub Actions cron.
 * No conversion metric. Includes daily plan progress.
 */

import { parse as csvParse } from "csv-parse/sync";

const CSV_URL  = process.env.CSV_URL; // unused now but kept for backward compat
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

function todayInTz() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  return { year: +parts.year, month: +parts.month, day: +parts.day };
}

function formatDailyPlanLines(totalPlan, totalSales) {
  if (!totalPlan) return "";
  const { year, month, day } = todayInTz();
  const daysInMonth = new Date(year, month, 0).getDate();
  const expected = Math.round(totalPlan * (day / daysInMonth));
  const delta = totalSales - expected;
  let s = "";
  s += `📅 День ${day} из ${daysInMonth} (${Math.round(day / daysInMonth * 100)}% месяца)\n`;
  s += `🎯 План на сегодня: <b>${expected}</b> продаж (из ${totalPlan})\n`;
  if (delta >= 0) s += `🚗 Факт: <b>${totalSales}</b> · впереди графика на <b>${delta}</b> продаж 🚀\n`;
  else            s += `🚗 Факт: <b>${totalSales}</b> · позади графика на <b>${-delta}</b> продаж ⚠️\n`;
  return s;
}

const MONTH_NAMES_RU = [
  "января","февраля","марта","апреля","мая","июня",
  "июля","августа","сентября","октября","ноября","декабря"
];

function buildMonthlyPlanCalendar(allData) {
  const { year, month, day: today } = todayInTz();
  const daysInMonth = new Date(year, month, 0).getDate();
  const officesWithPlans = allData.filter(d => d.total?.plan);
  if (!officesWithPlans.length) return "";

  const officeCols = officesWithPlans.map(({ office }) => ({
    label: office.name.length > 6 ? office.name.slice(0, 6) : office.name
  }));

  let s = `\n📆 <b>План по дням ${MONTH_NAMES_RU[month - 1]}:</b>\n<pre>`;
  s += `Дата   `;
  officeCols.forEach(c => { s += padL(c.label, 7); });
  s += padL("Σ", 6) + "  Статус\n";

  for (let d = 1; d <= daysInMonth; d++) {
    const fraction = d / daysInMonth;
    const dateStr = `${String(d).padStart(2, "0")}.${String(month).padStart(2, "0")}`;
    let totalForDay = 0;
    let allMet = true;
    let line = `${dateStr} `;
    officesWithPlans.forEach(({ office, total }) => {
      const target = Math.round(total.plan * fraction);
      totalForDay += target;
      if (d <= today && total.sales < target) allMet = false;
      line += padL(String(target), 7);
    });
    line += padL(String(totalForDay), 6) + "  ";

    let icon;
    if (d < today)        icon = allMet ? "✅" : "⛔";
    else if (d === today) icon = "📌 сегодня";
    else                  icon = "⏳";
    line += icon + "\n";
    s += line;
  }
  s += `</pre>`;
  return s;
}

function meanPercent(managers) {
  const pcts = managers.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
  return pcts.length ? (pcts.reduce((s, p) => s + p, 0) / pcts.length).toFixed(2).replace(".", ",") + "%" : "—";
}

function formatTable(managers) {
  const maxName = Math.max(...managers.map(m => m.name.length), 4);
  let block = `<pre>${padR("Имя", maxName)}  Деп Прод План    %\n`;
  managers.forEach(m => {
    const tag = m.sales > m.plan && m.plan > 0 ? " 🔥" : "";
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

  allData.forEach(({ office, managers, total }) => {
    msg += `${office.emoji} <b>${escHtml(office.name)}</b>\n`;
    msg += formatTable(managers) + "\n";
    if (total) {
      msg += `💵 Депозиты: <b>${total.deposits}</b> · 🚗 Продажи: <b>${total.sales}</b> / ${total.plan} · 🎯 <b>${escHtml(total.completion)}</b>\n`;
      msg += `📊 Среднее на менеджера: <b>${avg(total.sales, managers.length)}</b> прод · <b>${avg(total.deposits, managers.length)}</b> деп · 👥 ${managers.length} мен.\n`;
      msg += `📈 Средний % по менеджерам: <b>${meanPercent(managers)}</b>\n`;
      msg += formatDailyPlanLines(total.plan, total.sales);
    }
    msg += "\n";
  });

  const totalDeposits = allData.reduce((s, d) => s + (d.total?.deposits || 0), 0);
  const totalSales = allData.reduce((s, d) => s + (d.total?.sales || 0), 0);
  const totalPlan = allData.reduce((s, d) => s + (d.total?.plan || 0), 0);
  const totalManagers = allData.reduce((s, d) => s + d.managers.length, 0);
  const numOffices = allData.length;

  const allManagersFlat = allData.flatMap(d => d.managers);
  const completionPercents = allManagersFlat.map(m => parseFloat(String(m.completion).replace(",", ".").replace("%", "")) || 0);
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

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true
    })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Telegram API error: ${JSON.stringify(j)}`);
  console.log(`✅ Sent message_id=${j.result.message_id} to chat ${CHAT_ID}`);
}

async function main() {
  console.log(`▶ Fetching ${OFFICES.length} office(s)...`);
  const allData = await Promise.all(OFFICES.map(fetchOffice));
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
