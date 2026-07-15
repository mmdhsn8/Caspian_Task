import { config } from "dotenv";
config();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN as string;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID as string;

const url = "https://api.telegram.org/bot" + TOKEN + "/sendMessage";

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: CHAT_ID,
    text: "Node Telegram Debug",
  }),
});

console.log("HTTP " + response.status + " " + response.statusText);
for (const [key, value] of response.headers) {
  console.log("  " + key + ": " + value);
}
console.log("");
const raw = await response.text();
console.log(raw);
