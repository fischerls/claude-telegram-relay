/**
 * Daily Reminder
 *
 * Sends one standing principle to Telegram once a day:
 *
 *   "You can outsource your thinking, but you can't outsource your understanding."
 *
 * Thinking is delegable — to Claude, to a teammate, to a tool. Understanding is
 * not: it only forms in the mind that does the wrestling. This reminder is here
 * to keep that distinction in view while leaning on an AI assistant every day.
 *
 * Schedule this with:
 * - macOS:   bun run setup:launchd  -- --service reminder
 * - Linux:   bun run setup:services -- --service reminder
 * - Windows: bun run setup:services -- --service reminder
 *
 * Run manually: bun run examples/daily-reminder.ts
 */

import "dotenv/config";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_USER_ID || "";

const PRINCIPLE =
  "You can outsource your thinking, but you can't outsource your understanding.";

async function sendTelegram(message: string): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          parse_mode: "Markdown",
        }),
      }
    );
    return response.ok;
  } catch (error) {
    console.error("Telegram error:", error);
    return false;
  }
}

function buildReminder(): string {
  const dateStr = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return [
    "🧠 *Daily Reminder*",
    dateStr,
    "",
    `_${PRINCIPLE}_`,
    "",
    "Lean on the assistant to do the thinking — then make sure the understanding is yours.",
  ].join("\n");
}

async function main() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID");
    process.exit(1);
  }

  const ok = await sendTelegram(buildReminder());

  if (ok) {
    console.log("Daily reminder sent.");
  } else {
    console.error("Failed to send daily reminder.");
    process.exit(1);
  }
}

main();
