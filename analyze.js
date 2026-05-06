const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");

const key = fs.readFileSync(".env", "utf8").match(/ANTHROPIC_API_KEY=(.+)/)[1].trim();
const client = new Anthropic({ apiKey: key });

// --- Крок 1: Читаємо CSV ---
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

// --- Крок 2: Рахуємо метрики ---
function calcMetrics(campaigns) {
  return campaigns.map((c) => ({
    campaign: c.campaign,
    channel: c.channel,
    spend: c.spend,
    ctr: ((c.clicks / c.impressions) * 100).toFixed(2) + "%",
    cpc: (c.spend / c.clicks).toFixed(2),
    cac: (c.spend / c.conversions).toFixed(2),
    conv_rate: ((c.conversions / c.clicks) * 100).toFixed(2) + "%",
    romi: (((c.revenue - c.spend) / c.spend) * 100).toFixed(0) + "%",
    revenue: c.revenue,
  }));
}

// --- Крок 3: Виводимо таблицю ---
function printTable(metrics) {
  console.log("\n📊 АНАЛІЗ РЕКЛАМНИХ КАМПАНІЙ\n");
  console.log("─".repeat(90));
  console.log(
    "Кампанія".padEnd(25) +
    "Канал".padEnd(10) +
    "Витрати".padEnd(10) +
    "CTR".padEnd(8) +
    "CPC".padEnd(8) +
    "CAC".padEnd(8) +
    "Conv%".padEnd(8) +
    "ROMI".padEnd(8) +
    "Виручка"
  );
  console.log("─".repeat(90));
  metrics.forEach((m) => {
    console.log(
      m.campaign.padEnd(25) +
      m.channel.padEnd(10) +
      ("$" + m.spend).padEnd(10) +
      m.ctr.padEnd(8) +
      ("$" + m.cpc).padEnd(8) +
      ("$" + m.cac).padEnd(8) +
      m.conv_rate.padEnd(8) +
      m.romi.padEnd(8) +
      "$" + m.revenue
    );
  });
  console.log("─".repeat(90));
}

// --- Крок 4: Claude аналізує результати ---
async function getAIInsights(metrics) {
  const dataText = metrics
    .map(
      (m) =>
        `${m.campaign} (${m.channel}): витрати $${m.spend}, CTR ${m.ctr}, CAC $${m.cac}, ROMI ${m.romi}, виручка $${m.revenue}`
    )
    .join("\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [
      {
        role: "user",
        content: `Ти маркетинг-аналітик. Ось дані по рекламних кампаніях:\n\n${dataText}\n\nДай короткий висновок: які кампанії найефективніші, які треба вимкнути, і одну конкретну рекомендацію. Відповідай українською, коротко і по суті.`,
      },
    ],
  });

  return response.content[0].text;
}

// --- Запуск ---
async function main() {
  const campaigns = readCSV("data.csv");
  const metrics = calcMetrics(campaigns);

  printTable(metrics);

  console.log("\n🤖 AI-аналіз від Claude:\n");
  const insights = await getAIInsights(metrics);
  console.log(insights);
  console.log();
}

main();
