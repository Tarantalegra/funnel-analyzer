const Anthropic = require("@anthropic-ai/sdk");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const fs = require("fs");

// --- Конфіг ---
const env = fs.readFileSync(".env", "utf8");
const getEnv = (key) => env.match(new RegExp(key + "=(.+)"))[1].trim();

const SHEET_ID = "1IxUy27QcUZxBfTHpNmdH1fSKqvXDfszxEeY5VHE5CTk";
const bot = new TelegramBot(getEnv("TELEGRAM_TOKEN"), { polling: true });
const client = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

console.log("🤖 Бот запущено. Чекаю команди...");

// --- Читаємо Google Sheets ---
async function getSheetData() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "google-key.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Лист1!A:G",
  });
  const rows = response.data.values;
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
    max_tokens: 250,
    messages: [{
      role: "user",
      content: `Ти маркетинг-аналітик. Дані:\n\n${dataText}\n\nДай висновок у 2-3 реченнях: що працює, що вимкнути, одна рекомендація. Українською, коротко.`,
    }],
  });
  return response.content[0].text;
}

// --- /звіт — повний звіт ---
async function handleZvit(chatId) {
  await bot.sendMessage(chatId, "⏳ Читаю дані з Google Sheets...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const aiText = await getAIInsights(metrics);
  const sorted = [...metrics].sort((a, b) => b.romi - a.romi);

  let msg = "📊 <b>Повний звіт по воронці</b>\n";
  msg += `🗓 ${new Date().toLocaleDateString("uk-UA")}\n\n`;
  sorted.forEach((m) => {
    const emoji = m.romi > 200 ? "🟢" : m.romi > 0 ? "🟡" : "🔴";
    msg += `${emoji} <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   Витрати: $${m.spend} | ROMI: ${m.romi}% | CAC: $${m.cac}\n`;
  });
  msg += `\n🤖 <b>AI-висновок:</b>\n${aiText}`;
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- /топ — топ 3 кампанії за ROMI ---
async function handleTop(chatId) {
  await bot.sendMessage(chatId, "⏳ Шукаю найкращі кампанії...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const top3 = [...metrics].sort((a, b) => b.romi - a.romi).slice(0, 3);

  let msg = "🏆 <b>Топ-3 кампанії за ROMI</b>\n\n";
  top3.forEach((m, i) => {
    const medals = ["🥇", "🥈", "🥉"];
    msg += `${medals[i]} <b>${m.campaign}</b>\n`;
    msg += `   Канал: ${m.channel} | ROMI: ${m.romi}% | CAC: $${m.cac} | Виручка: $${m.revenue}\n\n`;
  });
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- /стоп — збиткові кампанії ---
async function handleStop(chatId) {
  await bot.sendMessage(chatId, "⏳ Перевіряю збиткові кампанії...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const losers = metrics.filter((m) => m.romi < 0);

  if (losers.length === 0) {
    await bot.sendMessage(chatId, "✅ Збиткових кампаній немає. Все в плюсі!");
    return;
  }

  let msg = "🛑 <b>Кампанії які треба вимкнути (ROMI < 0%)</b>\n\n";
  losers.forEach((m) => {
    msg += `❌ <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   Витрати: $${m.spend} | ROMI: ${m.romi}% | Збиток: $${m.spend - m.revenue}\n\n`;
  });
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- Обробник команд ---
bot.onText(/\/звіт/, async (msg) => {
  try { await handleZvit(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/\/топ/, async (msg) => {
  try { await handleTop(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/\/стоп/, async (msg) => {
  try { await handleStop(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/\/старт|\/start/, async (msg) => {
  const help = `👋 Привіт! Я аналізую рекламні кампанії.

Команди:
/звіт — повний звіт по всіх кампаніях
/топ — топ-3 кампанії за ROMI
/стоп — збиткові кампанії які треба вимкнути`;
  await bot.sendMessage(msg.chat.id, help);
});
