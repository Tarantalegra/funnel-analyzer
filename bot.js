const Anthropic = require("@anthropic-ai/sdk");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");
const fs = require("fs");
const http = require("http");
const cron = require("node-cron");

http.createServer((req, res) => res.end("ok")).listen(8080);

function getEnv(key) {
  if (process.env[key]) return process.env[key];
  try {
    const env = fs.readFileSync(".env", "utf8");
    return env.match(new RegExp(key + "=(.+)"))[1].trim();
  } catch {
    throw new Error(`Змінна ${key} не знайдена`);
  }
}

const SHEET_ID = "1IxUy27QcUZxBfTHpNmdH1fSKqvXDfszxEeY5VHE5CTk";
const bot = new TelegramBot(getEnv("TELEGRAM_TOKEN"), { polling: true });
const claude = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });

console.log("🤖 Funnel Bot запущено...");

// --- Глобальний обробник помилок ---
process.on("uncaughtException", async (err) => {
  console.error("Uncaught exception:", err.message);
  try {
    await bot.sendMessage(
      getEnv("TELEGRAM_CHAT_ID"),
      `⚠️ Критична помилка бота:\n${err.message}\n\nБот перезапускається...`
    );
  } catch {}
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// --- Сигнали зупинки від Fly.io ---
async function notifyShutdown(signal) {
  console.log(`${signal} received`);
  try {
    await bot.sendMessage(getEnv("TELEGRAM_CHAT_ID"), `⚠️ Funnel Bot зупиняється (${signal}). Fly.io перезапускає машину.`);
  } catch {}
  process.exit(0);
}
process.on("SIGTERM", () => notifyShutdown("SIGTERM"));
process.on("SIGINT", () => notifyShutdown("SIGINT"));

// --- Помилки Telegram polling ---
let lastPollingAlert = 0;
bot.on("polling_error", async (err) => {
  console.error("Polling error:", err.code, err.message);
  const now = Date.now();
  if (now - lastPollingAlert > 10 * 60 * 1000) {
    lastPollingAlert = now;
    try {
      await bot.sendMessage(getEnv("TELEGRAM_CHAT_ID"), `⚠️ Funnel Bot: помилка підключення до Telegram\n${err.code}: ${err.message}`);
    } catch {}
  }
});

// --- Retry: повторна спроба при помилці ---
async function withRetry(fn, retries = 2, delay = 3000) {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0) {
      console.log(`Помилка: ${e.message}. Повтор через ${delay / 1000}с...`);
      await new Promise((r) => setTimeout(r, delay));
      return withRetry(fn, retries - 1, delay);
    }
    throw e;
  }
}

// --- Читаємо Google Sheets ---
async function getSheetData() {
  return withRetry(async () => {
    const keyJson = process.env.GOOGLE_KEY_JSON
      ? JSON.parse(Buffer.from(process.env.GOOGLE_KEY_JSON, "base64").toString())
      : JSON.parse(fs.readFileSync("google-key.json", "utf8"));

    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
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
  });
}

// --- Рахуємо метрики (з захистом від ділення на 0) ---
function calcMetrics(campaigns) {
  return campaigns.map((c) => ({
    campaign: c.campaign,
    channel: c.channel,
    spend: c.spend,
    revenue: c.revenue,
    ctr: c.impressions > 0 ? ((c.clicks / c.impressions) * 100).toFixed(2) : "—",
    cpc: c.clicks > 0 ? (c.spend / c.clicks).toFixed(2) : "—",
    cac: c.conversions > 0 ? (c.spend / c.conversions).toFixed(2) : "—",
    romi: c.spend > 0 ? (((c.revenue - c.spend) / c.spend) * 100).toFixed(0) : "—",
  }));
}

// --- AI: загальний висновок ---
async function getAIInsights(metrics) {
  const dataText = metrics
    .map((m) => `${m.campaign} (${m.channel}): витрати $${m.spend}, CTR ${m.ctr}%, CPC $${m.cpc}, CAC $${m.cac}, ROMI ${m.romi}%, дохід $${m.revenue}`)
    .join("\n");

  const res = await withRetry(() =>
    claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Ти маркетинг-аналітик. Дані:\n\n${dataText}\n\nВисновок у 3-4 реченнях: що працює найкраще, що вимкнути, одна конкретна рекомендація. Українською, коротко.`,
      }],
    })
  );
  return res.content[0].text;
}

// --- AI: рекомендації по бюджету ---
async function getAIBudget(metrics) {
  const dataText = metrics
    .map((m) => `${m.campaign} (${m.channel}): витрати $${m.spend}, CTR ${m.ctr}%, CPC $${m.cpc}, CAC $${m.cac}, ROMI ${m.romi}%, дохід $${m.revenue}`)
    .join("\n");

  const res = await withRetry(() =>
    claude.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Ти маркетинг-аналітик. Дані:\n\n${dataText}\n\nДай конкретні рекомендації по бюджету:\n- Які канали масштабувати і на скільки %\n- Які канали скоротити або вимкнути\n- Куди перекинути вивільнений бюджет\nУкраїнською, по кожному каналу окремо.`,
      }],
    })
  );
  return res.content[0].text;
}

// --- /zvit — повний звіт ---
async function handleZvit(chatId) {
  await bot.sendMessage(chatId, "⏳ Читаю дані з Google Sheets...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const aiText = await getAIInsights(metrics);
  const sorted = [...metrics].sort((a, b) => parseFloat(b.romi) - parseFloat(a.romi));
  const date = new Date().toLocaleDateString("uk-UA");

  let msg = `📊 <b>Повний звіт по воронці</b>\n🗓 ${date}\n\n`;
  sorted.forEach((m) => {
    const romiNum = parseFloat(m.romi);
    const emoji = isNaN(romiNum) ? "⚪" : romiNum > 200 ? "🟢" : romiNum > 0 ? "🟡" : "🔴";
    msg += `${emoji} <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   Витрати: $${m.spend}  |  Дохід: $${m.revenue}\n`;
    msg += `   CTR: ${m.ctr}%  |  CPC: $${m.cpc}  |  CAC: $${m.cac}  |  ROMI: ${m.romi}%\n\n`;
  });
  msg += `🤖 <b>AI-висновок:</b>\n${aiText}`;
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- /top — топ-3 кампанії за ROMI ---
async function handleTop(chatId) {
  await bot.sendMessage(chatId, "⏳ Шукаю найкращі кампанії...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const top3 = [...metrics]
    .filter((m) => m.romi !== "—")
    .sort((a, b) => parseFloat(b.romi) - parseFloat(a.romi))
    .slice(0, 3);

  let msg = "🏆 <b>Топ-3 кампанії за ROMI</b>\n\n";
  top3.forEach((m, i) => {
    const medals = ["🥇", "🥈", "🥉"];
    msg += `${medals[i]} <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   ROMI: ${m.romi}%  |  CAC: $${m.cac}  |  CTR: ${m.ctr}%\n`;
    msg += `   Витрати: $${m.spend}  |  Дохід: $${m.revenue}\n\n`;
  });
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- /stop — збиткові кампанії ---
async function handleStop(chatId) {
  await bot.sendMessage(chatId, "⏳ Перевіряю збиткові кампанії...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const losers = metrics.filter((m) => m.romi !== "—" && parseFloat(m.romi) < 0);

  if (losers.length === 0) {
    await bot.sendMessage(chatId, "✅ Збиткових кампаній немає. Все в плюсі!");
    return;
  }

  let msg = "🛑 <b>Кампанії які треба вимкнути (ROMI &lt; 0%)</b>\n\n";
  losers.forEach((m) => {
    const loss = (m.spend - m.revenue).toFixed(0);
    msg += `❌ <b>${m.campaign}</b> (${m.channel})\n`;
    msg += `   Витрати: $${m.spend}  |  ROMI: ${m.romi}%  |  Збиток: $${loss}\n\n`;
  });
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- /budget — рекомендації по бюджету ---
async function handleBudget(chatId) {
  await bot.sendMessage(chatId, "⏳ Аналізую розподіл бюджету...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);
  const aiText = await getAIBudget(metrics);
  const date = new Date().toLocaleDateString("uk-UA");
  await bot.sendMessage(chatId, `💰 <b>Рекомендації по бюджету</b>\n🗓 ${date}\n\n${aiText}`, { parse_mode: "HTML" });
}

// --- /channel — зведення по каналах ---
async function handleChannel(chatId) {
  await bot.sendMessage(chatId, "⏳ Аналізую по каналах...");
  const campaigns = await getSheetData();
  const metrics = calcMetrics(campaigns);

  const channels = {};
  metrics.forEach((m) => {
    if (!channels[m.channel]) channels[m.channel] = { spend: 0, revenue: 0, count: 0 };
    channels[m.channel].spend += m.spend;
    channels[m.channel].revenue += m.revenue;
    channels[m.channel].count++;
  });

  const sorted = Object.entries(channels).sort((a, b) => {
    const roiA = (a[1].revenue - a[1].spend) / a[1].spend;
    const roiB = (b[1].revenue - b[1].spend) / b[1].spend;
    return roiB - roiA;
  });

  let msg = `📱 <b>Зведення по каналах</b>\n🗓 ${new Date().toLocaleDateString("uk-UA")}\n\n`;
  sorted.forEach(([channel, d]) => {
    const romi = d.spend > 0 ? (((d.revenue - d.spend) / d.spend) * 100).toFixed(0) : "—";
    const romiNum = parseFloat(romi);
    const emoji = isNaN(romiNum) ? "⚪" : romiNum > 200 ? "🟢" : romiNum > 0 ? "🟡" : "🔴";
    msg += `${emoji} <b>${channel}</b>\n`;
    msg += `   Витрати: $${d.spend}  |  Дохід: $${d.revenue}  |  ROMI: ${romi}%\n`;
    msg += `   Кампаній: ${d.count}\n\n`;
  });
  await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
}

// --- Меню ---
const menuKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: "📊 Повний звіт" }, { text: "🏆 Топ кампанії" }],
      [{ text: "🛑 Збиткові" }, { text: "💰 Бюджет" }],
      [{ text: "📱 По каналах" }, { text: "🏓 Ping" }],
    ],
    resize_keyboard: true,
  },
};

// --- Команди ---
bot.onText(/^\/zvit(@\w+)?$/, async (msg) => {
  try { await handleZvit(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/^\/top(@\w+)?$/, async (msg) => {
  try { await handleTop(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/^\/stop(@\w+)?$/, async (msg) => {
  try { await handleStop(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/^\/budget(@\w+)?$/, async (msg) => {
  try { await handleBudget(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/^\/channel(@\w+)?$/, async (msg) => {
  try { await handleChannel(msg.chat.id); }
  catch (e) { await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message); }
});

bot.onText(/^\/ping(@\w+)?$/, async (msg) => {
  const time = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  await bot.sendMessage(msg.chat.id, `✅ Funnel Bot живий  ${time}`);
});

bot.onText(/^\/menu(@\w+)?$/, async (msg) => {
  await bot.sendMessage(msg.chat.id, "Оберіть дію:", menuKeyboard);
});

bot.onText(/^\/start(@\w+)?$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `👋 Funnel Bot активний!\n\n` +
    `/zvit — повний звіт по всіх кампаніях\n` +
    `/top — топ-3 кампанії за ROMI\n` +
    `/stop — збиткові кампанії\n` +
    `/budget — рекомендації по бюджету\n` +
    `/channel — зведення по каналах\n` +
    `/ping — перевірити чи бот живий\n` +
    `/menu — відкрити меню`,
    menuKeyboard
  );
});

// --- Обробка кнопок меню ---
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;
  try {
    if (msg.text === "📊 Повний звіт") await handleZvit(msg.chat.id);
    else if (msg.text === "🏆 Топ кампанії") await handleTop(msg.chat.id);
    else if (msg.text === "🛑 Збиткові") await handleStop(msg.chat.id);
    else if (msg.text === "💰 Бюджет") await handleBudget(msg.chat.id);
    else if (msg.text === "📱 По каналах") await handleChannel(msg.chat.id);
    else if (msg.text === "🏓 Ping") {
      const time = new Date().toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
      await bot.sendMessage(msg.chat.id, `✅ Funnel Bot живий  ${time}`);
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, "❌ Помилка: " + e.message);
  }
});

// --- Автозвіт щодня о 9:00 Київ (06:00 UTC) ---
cron.schedule("0 6 * * *", async () => {
  try {
    console.log("Автозвіт: відправляю...");
    await handleZvit(getEnv("TELEGRAM_CHAT_ID"));
  } catch (e) {
    console.error("Автозвіт помилка:", e.message);
    await bot.sendMessage(
      getEnv("TELEGRAM_CHAT_ID"),
      `⚠️ Автозвіт не вдався: ${e.message}`
    ).catch(() => {});
  }
}, { timezone: "UTC" });
