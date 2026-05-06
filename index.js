const Anthropic = require("@anthropic-ai/sdk");
require("fs");

const key = require("fs")
  .readFileSync(".env", "utf8")
  .match(/ANTHROPIC_API_KEY=(.+)/)[1]
  .trim();

const client = new Anthropic({ apiKey: key });

async function main() {
  console.log("Відправляю запит до Claude...\n");

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 200,
    messages: [
      {
        role: "user",
        content: "Назви 3 ключові метрики для оцінки ефективності маркетингової воронки. Відповідай коротко.",
      },
    ],
  });

  console.log("Відповідь від Claude:");
  console.log(response.content[0].text);
}

main();
