const Anthropic = require("@anthropic-ai/sdk");
const { google } = require("googleapis");
const fs = require("fs");

// --- Конфіг ---
const env = fs.readFileSync(".env", "utf8");
const getEnv = (key) => env.match(new RegExp(key + "=(.+)"))[1].trim();

const SHEET_ID = "1IxUy27QcUZxBfTHpNmdH1fSKqvXDfszxEeY5VHE5CTk";
const SHEET_NAME = "Лист1";
const TELEGRAM_TOKEN = getEnv("TELEGRAM_TOKEN");
const CHAT_ID = getEnv("TELEGRAM_CHAT_ID");
const client = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

// --- Підключення до Google Sheets ---
async function getSheetData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "google-key.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:G`,
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) throw new Error("Таблиця порожня або немає даних");

  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = isNaN(row[i]) ? (row[i] || "").trim() : parseFloat(row[i]);
    });
    return obj;
  });
}

// --- Рахуємо метрики ---
function calcMetrics(campaigns) {
  return campaigns.map((c) => ({
    campaign: c.campaign,
    channel: c.channel,
    spend: c.spend,
    ctr: ((c.clicks / c.impressions) * 100).toFixed(2),
    cac: (c.spend / c.conversions).toFixed(2),
    romi: (((c.revenue - c.spend) / c.spend) * 100).toFixed(0),
    revenue: c.revenue,
  }));
}

// --- AI висновок ---
async function getAIInsights(metrics) {
  const dataText = metrics
    .map((m) => `${m.campaign} (${m.channel}): витрати $${m.spend}, CTR ${m.ctr}%, CAC $${m.cac}, ROMI ${m.romi}%, виручка $${m.revenue}`)
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Ти маркетинг-аналітик. Дані по кампаніях:\n\n${dataText}\n\nДай висновок у 2-3 реченнях: що працює добре, що вимкнути, одна рекомендація. Відповідай українською, без заголовків.`,
    }],
  });

  return response.content[0].text;
}

// --- Telegram ---
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  const result = await res.json();
  if (!result.ok) throw new Error("Telegram помилка: " + result.description);
}

// --- Формуємо повідомлення ---
function buildMessage(metrics, aiText) {
  const sorted = [...metrics].sort((a, b) => b.romi - a.romi);
  let msg = "📊 <b>Звіт по воронці (Google Sheets)</b>\n";
  msg += `🗓 ${new Date().toLocaleDateString("uk-UA")}\n\n`;
  sorted.forEach((m) => {
    const emoji = m.romi > 200 ? "🟢" : m.romi > 0 ? "🟡" : "🔴";
    msg += `${emoji} <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   Витрати: $${m.spend} | ROMI: ${m.romi}% | CAC: $${m.cac}\n`;
  });
  msg += `\n🤖 <b>AI-висновок:</b>\n${aiText}`;
  return msg;
}

// --- Запуск ---
async function main() {
  console.log("Читаю дані з Google Sheets...");
  const campaigns = await getSheetData();
  console.log(`Знайдено ${campaigns.length} кампаній`);

  const metrics = calcMetrics(campaigns);

  console.log("Отримую AI висновок...");
  const aiText = await getAIInsights(metrics);

  console.log("Відправляю в Telegram...");
  const message = buildMessage(metrics, aiText);
  await sendTelegram(message);

  console.log("✅ Готово! Перевіряй Telegram.");
}

main();
