const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

// --- Читаємо .env ---
const env = fs.readFileSync(".env", "utf8");
const getEnv = (key) => env.match(new RegExp(key + "=(.+)"))[1].trim();

const client = new Anthropic({ apiKey: getEnv("ANTHROPIC_API_KEY") });
const TELEGRAM_TOKEN = getEnv("TELEGRAM_TOKEN");
const CHAT_ID = getEnv("TELEGRAM_CHAT_ID");

// --- Читаємо CSV ---
function readCSV(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    const row = {};
    headers.forEach((h, i) => {
      row[h.trim()] = isNaN(values[i]) ? values[i].trim() : parseFloat(values[i]);
    });
    return row;
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

// --- Отримуємо AI висновок ---
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

// --- Формуємо Telegram повідомлення ---
function buildMessage(metrics, aiText) {
  const sorted = [...metrics].sort((a, b) => b.romi - a.romi);

  let msg = "📊 <b>Щоденний звіт по воронці</b>\n";
  msg += `🗓 ${new Date().toLocaleDateString("uk-UA")}\n\n`;

  msg += "<b>Кампанії по ROMI:</b>\n";
  sorted.forEach((m) => {
    const emoji = m.romi > 200 ? "🟢" : m.romi > 0 ? "🟡" : "🔴";
    msg += `${emoji} <b>${m.campaign}</b>\n`;
    msg += `   Канал: ${m.channel} | Витрати: $${m.spend} | ROMI: ${m.romi}% | CAC: $${m.cac}\n`;
  });

  msg += `\n🤖 <b>AI-висновок:</b>\n${aiText}`;
  return msg;
}

// --- Відправляємо в Telegram ---
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "HTML",
    }),
  });

  const result = await response.json();
  if (!result.ok) throw new Error("Telegram помилка: " + result.description);
  return result;
}

// --- Запуск ---
async function main() {
  console.log("Аналізую дані...");
  const campaigns = readCSV("data.csv");
  const metrics = calcMetrics(campaigns);

  console.log("Отримую AI висновок...");
  const aiText = await getAIInsights(metrics);

  console.log("Відправляю в Telegram...");
  const message = buildMessage(metrics, aiText);
  await sendTelegram(message);

  console.log("✅ Повідомлення відправлено!");
}

main();
