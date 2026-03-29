/**
 * Claude Code Telegram Relay
 *
 * Minimal relay that connects Telegram to Claude Code CLI.
 * Customize this for your own needs.
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { spawn } from "bun";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { transcribe } from "./transcribe.ts";
import {
  processMemoryIntents,
  getMemoryContext,
  getRelevantContext,
} from "./memory.ts";

const PROJECT_ROOT = dirname(dirname(import.meta.path));

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_DIR = process.env.PROJECT_DIR || "";
const RELAY_DIR = process.env.RELAY_DIR || join(process.env.HOME || "~", ".claude-relay");

// Tools Dexter is allowed to use without prompting
const ALLOWED_TOOLS = [
  // Google Calendar & Gmail — use `gws` CLI via Bash (auto-refreshing OAuth)
  // MCP tools removed: their OAuth tokens expire and require manual re-auth
  // GHL / GrowthOS
  "mcp__ghl__ghl_search_contacts",
  "mcp__ghl__ghl_get_contact",
  "mcp__ghl__ghl_create_contact",
  "mcp__ghl__ghl_update_contact",
  "mcp__ghl__ghl_add_contact_tags",
  "mcp__ghl__ghl_delete_contact",
  "mcp__ghl__ghl_list_pipelines",
  "mcp__ghl__ghl_search_opportunities",
  "mcp__ghl__ghl_get_opportunity",
  "mcp__ghl__ghl_create_opportunity",
  "mcp__ghl__ghl_update_opportunity",
  "mcp__ghl__ghl_list_conversations",
  "mcp__ghl__ghl_get_conversation",
  "mcp__ghl__ghl_send_message",
  "mcp__ghl__ghl_list_calendars",
  "mcp__ghl__ghl_get_calendar_slots",
  "mcp__ghl__ghl_list_appointments",
  "mcp__ghl__ghl_create_appointment",
  "mcp__ghl__ghl_get_location",
  "mcp__ghl__ghl_list_tags",
  "mcp__ghl__ghl_list_custom_fields",
  "mcp__ghl__ghl_list_contact_notes",
  "mcp__ghl__ghl_create_contact_note",
  "mcp__ghl__ghl_list_contact_tasks",
  "mcp__ghl__ghl_create_contact_task",
  "mcp__ghl__ghl_list_social_accounts",
  "mcp__ghl__ghl_create_social_post",
  "mcp__ghl__ghl_upload_social_media",
  "mcp__ghl__ghl_list_workflows",
  "mcp__ghl__ghl_add_contact_to_workflow",
  "mcp__ghl__ghl_remove_contact_from_workflow",
  // File tools
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Bash",
  "WebSearch",
  "WebFetch",
].join(",");

// Directories
const TEMP_DIR = join(RELAY_DIR, "temp");
const UPLOADS_DIR = join(RELAY_DIR, "uploads");

// Session tracking for conversation continuity
const SESSION_FILE = join(RELAY_DIR, "session.json");

interface SessionState {
  sessionId: string | null;
  lastActivity: string;
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================

async function loadSession(): Promise<SessionState> {
  try {
    const content = await readFile(SESSION_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return { sessionId: null, lastActivity: new Date().toISOString() };
  }
}

async function saveSession(state: SessionState): Promise<void> {
  await writeFile(SESSION_FILE, JSON.stringify(state, null, 2));
}

let session = await loadSession();

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

const LOCK_FILE = join(RELAY_DIR, "bot.lock");

async function acquireLock(): Promise<boolean> {
  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0); // Check if process exists
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

// Cleanup on exit
process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(TEMP_DIR, { recursive: true });
await mkdir(UPLOADS_DIR, { recursive: true });

// ============================================================
// SUPABASE (optional — only if configured)
// ============================================================

const supabase: SupabaseClient | null =
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
    : null;

async function saveMessage(
  role: string,
  content: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("messages").insert({
      role,
      content,
      channel: "telegram",
      metadata: metadata || {},
    });
  } catch (error) {
    console.error("Supabase save error:", error);
  }
}

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If ALLOWED_USER_ID is set, enforce it
  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// CORE: Call Claude CLI
// ============================================================

const PROGRESS_INTERVAL_MS = 30 * 1000; // Send progress update every 30 seconds

const PROGRESS_MESSAGES = [
  "Still working on this...",
  "Taking a bit longer than usual, hang tight...",
  "Still going. Complex request, give me a moment...",
  "Almost there (or at least trying)...",
  "Still processing. I'll let you know when it's done...",
];

async function callClaude(
  prompt: string,
  options?: { resume?: boolean; imagePath?: string; onProgress?: () => Promise<void> }
): Promise<string> {
  const args = [CLAUDE_PATH, "-p", prompt, "--allowedTools", ALLOWED_TOOLS];

  // Resume previous session if available and requested
  if (options?.resume && session.sessionId) {
    args.push("--resume", session.sessionId);
  }

  args.push("--output-format", "json");

  console.log(`Calling Claude: ${prompt.substring(0, 50)}...`);

  // Progress ticker: sends updates so the user knows we're not stuck
  let progressCount = 0;
  const progressTimer = options?.onProgress
    ? setInterval(async () => {
        try {
          await options.onProgress!();
          progressCount++;
        } catch (err) {
          console.error("Progress update failed:", err);
        }
      }, PROGRESS_INTERVAL_MS)
    : null;

  const clearProgress = () => {
    if (progressTimer) clearInterval(progressTimer);
  };

  try {
    const proc = spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: PROJECT_DIR || undefined,
      env: {
        ...process.env,
        // Pass through any env vars Claude might need
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    clearProgress();

    if (exitCode !== 0) {
      console.error("Claude error:", stderr);
      return `Error: ${stderr || "Claude exited with code " + exitCode}`;
    }

    // Parse JSON output to extract session ID and response text
    let responseText = output.trim();
    try {
      const json = JSON.parse(output);
      if (json.session_id) {
        session.sessionId = json.session_id;
        session.lastActivity = new Date().toISOString();
        await saveSession(session);
        console.log(`Session saved: ${json.session_id}`);
      }
      // Extract text from the JSON result
      responseText = json.result || json.text || responseText;
    } catch {
      // If JSON parsing fails, fall back to raw output
      console.warn("Could not parse Claude JSON output, using raw text");
    }

    return responseText;
  } catch (error: unknown) {
    clearProgress();
    const msg = error instanceof Error ? error.message : String(error);
    console.error("Claude call failed:", msg);
    return `Error: Could not run Claude CLI`;
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

// Helper: create a progress callback for a given chat context
function makeProgressCallback(ctx: Context) {
  let count = 0;
  return async () => {
    const msg = PROGRESS_MESSAGES[Math.min(count, PROGRESS_MESSAGES.length - 1)];
    const elapsed = Math.round(((count + 1) * PROGRESS_INTERVAL_MS) / 1000);
    await ctx.reply(`${msg} (${elapsed}s elapsed)`);
    await ctx.replyWithChatAction("typing");
    count++;
  };
}

// Text messages
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  console.log(`Message: ${text.substring(0, 50)}...`);

  await ctx.replyWithChatAction("typing");

  await saveMessage("user", text);

  // Gather context: semantic search + facts/goals
  const [relevantContext, memoryContext] = await Promise.all([
    getRelevantContext(supabase, text),
    getMemoryContext(supabase),
  ]);

  const enrichedPrompt = buildPrompt(text, relevantContext, memoryContext);
  const rawResponse = await callClaude(enrichedPrompt, {
    resume: true,
    onProgress: makeProgressCallback(ctx),
  });

  // Parse and save any memory intents, strip tags from response
  const response = await processMemoryIntents(supabase, rawResponse);

  await saveMessage("assistant", response);
  await sendResponse(ctx, response);
});

// Voice messages
bot.on("message:voice", async (ctx) => {
  const voice = ctx.message.voice;
  console.log(`Voice message: ${voice.duration}s`);
  await ctx.replyWithChatAction("typing");

  if (!process.env.VOICE_PROVIDER) {
    await ctx.reply(
      "Voice transcription is not set up yet. " +
        "Run the setup again and choose a voice provider (Groq or local Whisper)."
    );
    return;
  }

  try {
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    const transcription = await transcribe(buffer);
    if (!transcription) {
      await ctx.reply("Could not transcribe voice message.");
      return;
    }

    await saveMessage("user", `[Voice ${voice.duration}s]: ${transcription}`);

    const [relevantContext, memoryContext] = await Promise.all([
      getRelevantContext(supabase, transcription),
      getMemoryContext(supabase),
    ]);

    const enrichedPrompt = buildPrompt(
      `[Voice message transcribed]: ${transcription}`,
      relevantContext,
      memoryContext
    );
    const rawResponse = await callClaude(enrichedPrompt, {
      resume: true,
      onProgress: makeProgressCallback(ctx),
    });
    const claudeResponse = await processMemoryIntents(supabase, rawResponse);

    await saveMessage("assistant", claudeResponse);
    await sendResponse(ctx, claudeResponse);
  } catch (error) {
    console.error("Voice error:", error);
    await ctx.reply("Could not process voice message. Check logs for details.");
  }
});

// Photos/Images
bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    // Get highest resolution photo
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    // Download the image
    const timestamp = Date.now();
    const filePath = join(UPLOADS_DIR, `image_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    // Claude Code can see images via file path
    const caption = ctx.message.caption || "Analyze this image.";
    const prompt = `[Image: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Image]: ${caption}`);

    const claudeResponse = await callClaude(prompt, {
      resume: true,
      onProgress: makeProgressCallback(ctx),
    });

    // Cleanup after processing
    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// Documents
bot.on("message:document", async (ctx) => {
  const doc = ctx.message.document;
  console.log(`Document: ${doc.file_name}`);
  await ctx.replyWithChatAction("typing");

  try {
    const file = await ctx.getFile();
    const timestamp = Date.now();
    const fileName = doc.file_name || `file_${timestamp}`;
    const filePath = join(UPLOADS_DIR, `${timestamp}_${fileName}`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || `Analyze: ${doc.file_name}`;
    const prompt = `[File: ${filePath}]\n\n${caption}`;

    await saveMessage("user", `[Document: ${doc.file_name}]: ${caption}`);

    const claudeResponse = await callClaude(prompt, {
      resume: true,
      onProgress: makeProgressCallback(ctx),
    });

    await unlink(filePath).catch(() => {});

    const cleanResponse = await processMemoryIntents(supabase, claudeResponse);
    await saveMessage("assistant", cleanResponse);
    await sendResponse(ctx, cleanResponse);
  } catch (error) {
    console.error("Document error:", error);
    await ctx.reply("Could not process document.");
  }
});

// ============================================================
// HELPERS
// ============================================================

// Load profile once at startup
let profileContext = "";
try {
  profileContext = await readFile(join(PROJECT_ROOT, "config", "profile.md"), "utf-8");
} catch {
  // No profile yet — that's fine
}

const USER_NAME = process.env.USER_NAME || "";
const USER_TIMEZONE = process.env.USER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;

function buildPrompt(
  userMessage: string,
  relevantContext?: string,
  memoryContext?: string
): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: USER_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = [
    "You are a personal AI assistant responding via Telegram. Keep responses concise and conversational.",
  ];

  if (USER_NAME) parts.push(`You are speaking with ${USER_NAME}.`);
  parts.push(`Current time: ${timeStr}`);
  if (profileContext) parts.push(`\nProfile:\n${profileContext}`);
  if (memoryContext) parts.push(`\n${memoryContext}`);
  if (relevantContext) parts.push(`\n${relevantContext}`);

  parts.push(
    "\nGOOGLE WORKSPACE:" +
      "\nIMPORTANT: Do NOT use MCP tools for Gmail or Calendar — they are disabled because their tokens expire." +
      "\nALWAYS use the `gws` CLI via the Bash tool for ALL Google Workspace operations. It has auto-refreshing OAuth." +
      "\nServices available:" +
      "\n- Gmail: `gws gmail users messages list --params '{\"userId\":\"me\",\"maxResults\":10,\"q\":\"is:unread\"}'`" +
      "\n- Gmail read: `gws gmail users messages get --params '{\"userId\":\"me\",\"id\":\"MSG_ID\",\"format\":\"full\"}'`" +
      "\n- Gmail send: `gws gmail users messages send --params '{\"userId\":\"me\"}' --json '{\"raw\":\"BASE64_RFC2822\"}'`" +
      "\n- Calendar: `gws calendar events list --params '{\"calendarId\":\"primary\",\"timeMin\":\"2026-03-19T00:00:00Z\",\"maxResults\":10,\"singleEvents\":true,\"orderBy\":\"startTime\"}'`" +
      "\n- Calendar create: `gws calendar events insert --params '{\"calendarId\":\"primary\"}' --json '{\"summary\":\"Meeting\",\"start\":{\"dateTime\":\"...\"},\"end\":{\"dateTime\":\"...\"}}'`" +
      "\n- Drive: `gws drive files list --params '{\"pageSize\":10}'`" +
      "\n- Sheets read: `gws sheets spreadsheets values get --params '{\"spreadsheetId\":\"ID\",\"range\":\"Sheet1!A1:Z100\"}'`" +
      "\n- Sheets append: `gws sheets spreadsheets values append --params '{\"spreadsheetId\":\"ID\",\"range\":\"Sheet1\",\"valueInputOption\":\"USER_ENTERED\"}' --json '{\"values\":[[\"a\",\"b\"]]}'`" +
      "\n- Docs: `gws docs documents get --params '{\"documentId\":\"ID\"}'`" +
      "\nUse `gws schema <service.resource.method>` to discover exact params for any method." +
      "\nAlways use userId 'me' for Gmail. Always use calendarId 'primary' for Calendar unless specified."
  );

  parts.push(
    "\nGHL / GROWTHOS CRM:" +
      "\nYou have full access to GrowthOS (GoHighLevel) via MCP tools. You can:" +
      "\n- Search, create, update, delete contacts (ghl_search_contacts, ghl_create_contact, etc.)" +
      "\n- Manage pipelines and opportunities (ghl_list_pipelines, ghl_create_opportunity, etc.)" +
      "\n- List and trigger workflows (ghl_list_workflows, ghl_add_contact_to_workflow)" +
      "\n- Manage conversations and send messages (ghl_list_conversations, ghl_send_message)" +
      "\n- Manage calendars and appointments (ghl_list_calendars, ghl_create_appointment)" +
      "\n- Manage tags, notes, tasks, custom fields" +
      "\n- Social media posting (ghl_create_social_post, ghl_upload_social_media)"
  );

  parts.push(
    "\nMEMORY MANAGEMENT:" +
      "\nWhen the user shares something worth remembering, sets goals, or completes goals, " +
      "include these tags in your response (they are processed automatically and hidden from the user):" +
      "\n[REMEMBER: fact to store]" +
      "\n[GOAL: goal text | DEADLINE: optional date]" +
      "\n[DONE: search text for completed goal]"
  );

  parts.push(`\nUser: ${userMessage}`);

  return parts.join("\n");
}

async function sendResponse(ctx: Context, response: string): Promise<void> {
  // Telegram has a 4096 character limit
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  // Split long responses
  const chunks = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Telegram Relay...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Project directory: ${PROJECT_DIR || "(relay working directory)"}`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
