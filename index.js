// STAIN SPAMMING BOT - share links to WhatsApp group statuses, fully controlled from Telegram.
// Multisession pattern + pinned Baileys (7.0.0-rc11) taken from Stain x Habibi.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const TelegramBot = require('node-telegram-bot-api');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');
const Pino = require('pino');

// ---------------------------------------------------------------- config
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!TOKEN) { console.error('[FATAL] TELEGRAM_BOT_TOKEN is missing.'); process.exit(1); }
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '');
const ADMIN_IDS = new Set([OWNER_ID, ...(process.env.TELEGRAM_ADMIN_IDS || '').split(',')]
  .map(s => s.trim()).filter(Boolean));
const BOT_NAME = process.env.BOT_NAME || 'Stain Spamming Bot';
const OWNER_NAME = process.env.OWNER_NAME || '⎯꟭𝐒꟭𝜋꟭ߟ፝۬ͬ͡α꟭ᴵ꟭ᑀ꟭꟭͜➹';
const OWNER_LINK = process.env.OWNER_LINK || 'https://t.me/heisevanss';
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 30);
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || 2);
const POST_DELAY_MIN = Number(process.env.POST_DELAY_MIN || 3000);
const POST_DELAY_MAX = Number(process.env.POST_DELAY_MAX || 6000);

const DATA = process.env.DATA_DIR || __dirname;
const SESSIONS_DIR = path.join(DATA, 'sessions');
const DB_DIR = path.join(DATA, 'database');
for (const d of [SESSIONS_DIR, DB_DIR]) fs.mkdirSync(d, { recursive: true });
const DB = {
  paired: path.join(DB_DIR, 'paired.json'),
  notified: path.join(DB_DIR, 'notified.json'),
  users: path.join(DB_DIR, 'users.json'),
  blocked: path.join(DB_DIR, 'blocked.json')
};

global.botStartTime = Date.now();
const bot = new TelegramBot(TOKEN, { polling: true });
const activeSessions = new Map();   // sessionName -> { conn, ownerNumber, telegramChatId, retries, online }
const removing = new Set();         // sessions being removed on purpose
const awaiting = new Map();         // tgId -> { type }
const flows = new Map();            // tgId -> /ggstatus flow state
