const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = '1151575407666139291';
const REQUESTS_FILE = 'requests.json';
const CLAUDE_MODEL = 'claude-opus-4-7';
const CODEX_MODEL = 'gpt-5.5';
const GEMINI_MODEL = 'gemini-2.5-pro';
const BANANA_MODEL = 'gemini-3.1-flash-image-preview';
const MAX_HISTORY = 20;

// ─── История чатов (в памяти) ────────────────────────────────
const chatHistory = new Map();

function getHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  return chatHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function clearHistory(userId) {
  chatHistory.set(userId, []);
}

// ─── Загрузка/сохранение запросов ────────────────────────────
function loadRequests() {
  if (!fs.existsSync(REQUESTS_FILE)) fs.writeFileSync(REQUESTS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
}

function saveRequests(data) {
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(data, null, 2));
}

function getRequests(userId) {
  return loadRequests()[userId] ?? 0;
}

function setRequests(userId, count) {
  const data = loadRequests();
  data[userId] = count;
  saveRequests(data);
}

// ─── Разбивка длинного текста на части ───────────────────────
function splitMessage(text, maxLength = 1900) {
  const parts = [];
  while (text.length > 0) {
    if (text.length <= maxLength) {
      parts.push(text);
      break;
    }
    let splitAt = text.lastIndexOf('\n', maxLength);
    if (splitAt === -1) splitAt = maxLength;
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return parts;
}

// ─── Универсальная отправка ответа (с футером) ───────────────
async function sendReply(message, reply, remaining) {
  const footer = `\n\n*Осталось запросов: **${remaining}***`;
  if (reply.length > 1900) {
    const parts = splitMessage(reply);
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      if (i === 0) await message.reply(parts[i] + (isLast ? footer : ''));
      else await message.channel.send(parts[i] + (isLast ? footer : ''));
    }
  } else {
    await message.reply(reply + footer);
  }
}

// ─── Отправка ответа без футера (для бесплатных команд) ──────
async function sendReplyFree(message, reply) {
  if (reply.length > 1900) {
    const parts = splitMessage(reply);
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) await message.reply(parts[i]);
      else await message.channel.send(parts[i]);
    }
  } else {
    await message.reply(reply);
  }
}

// ─── Клиенты ─────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.gym-rat.online',
});

const codex = new OpenAI({
  apiKey: process.env.CODEX_API_KEY,
  baseURL: 'https://codex.sale/v1',
});

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── История для Gemini (отдельная, в формате Gemini) ────────
const geminiHistory = new Map();
const bananaHistory = new Map();

function getGeminiHistory(map, userId) {
  if (!map.has(userId)) map.set(userId, []);
  return map.get(userId);
}

function addToGeminiHistory(map, userId, role, text) {
  const history = getGeminiHistory(map, userId);
  // Gemini использует 'user' и 'model' вместо 'assistant'
  history.push({ role, parts: [{ text }] });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ─── Обработка сообщений ─────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  const userId = message.author.id;

  // ── !claude <вопрос> ──────────────────────────────────────
  if (content.startsWith('!claude')) {
    const text = content.slice('!claude'.length).trim();

    if (!text) {
      await message.reply('❌ Напишите вопрос после `!claude`.');
      return;
    }

    const remaining = getRequests(userId);
    if (remaining <= 0) {
      await message.reply('❌ У вас закончились запросы. Обратитесь к администратору.');
      return;
    }

    setRequests(userId, remaining - 1);
    addToHistory(userId, 'user', text);

    try {
      await message.channel.sendTyping();

      const stream = await anthropic.messages.stream({
        model: CLAUDE_MODEL,
        max_tokens: 131072,
        messages: getHistory(userId),
      });

      const response = await stream.finalMessage();
      const reply = response.content[0].text;
      addToHistory(userId, 'assistant', reply);
      await sendReply(message, reply, remaining - 1);
    } catch (e) {
      console.error(`Claude API error: ${e.constructor.name}: ${e.message}`);
      const history = getHistory(userId);
      if (history.at(-1)?.role === 'user') history.pop();
      setRequests(userId, remaining);
      await message.reply(`❌ Ошибка Claude: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !codex <вопрос> ───────────────────────────────────────
  if (content.startsWith('!codex')) {
    const text = content.slice('!codex'.length).trim();

    if (!text) {
      await message.reply('❌ Напишите вопрос после `!codex`.');
      return;
    }

    const remaining = getRequests(userId);
    if (remaining <= 0) {
      await message.reply('❌ У вас закончились запросы. Обратитесь к администратору.');
      return;
    }

    setRequests(userId, remaining - 1);
    addToHistory(userId, 'user', text);

    try {
      await message.channel.sendTyping();

      const response = await codex.chat.completions.create({
        model: CODEX_MODEL,
        messages: getHistory(userId),
        max_tokens: 4096,
      });

      const reply = response.choices[0].message.content;
      addToHistory(userId, 'assistant', reply);
      await sendReply(message, reply, remaining - 1);
    } catch (e) {
      console.error(`Codex API error: ${e.constructor.name}: ${e.message}`);
      const history = getHistory(userId);
      if (history.at(-1)?.role === 'user') history.pop();
      setRequests(userId, remaining);
      await message.reply(`❌ Ошибка Codex: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !gemini <вопрос> ──────────────────────────────────────
  if (content.startsWith('!gemini')) {
    const text = content.slice('!gemini'.length).trim();

    if (!text) {
      await message.reply('❌ Напишите вопрос после `!gemini`.');
      return;
    }

    try {
      await message.channel.sendTyping();

      const history = getGeminiHistory(geminiHistory, userId);
      const chat = genai.chats.create({
        model: GEMINI_MODEL,
        history,
      });

      const response = await chat.sendMessage({ message: text });
      const reply = response.text;

      addToGeminiHistory(geminiHistory, userId, 'user', text);
      addToGeminiHistory(geminiHistory, userId, 'model', reply);

      await sendReplyFree(message, reply);
    } catch (e) {
      console.error(`Gemini API error: ${e.constructor.name}: ${e.message}`);
      await message.reply(`❌ Ошибка Gemini: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !banana <вопрос> [+ изображение] ─────────────────────
  if (content.startsWith('!banana')) {
    const text = content.slice('!banana'.length).trim();

    if (!text && message.attachments.size === 0) {
      await message.reply('❌ Напишите вопрос и/или прикрепите изображение после `!banana`.');
      return;
    }

    try {
      await message.channel.sendTyping();

      const history = getGeminiHistory(bananaHistory, userId);
      const chat = genai.chats.create({
        model: BANANA_MODEL,
        history,
      });

      // Собираем parts: текст + возможные изображения
      const parts = [];

      // Обрабатываем прикреплённые изображения
      if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
          const mimeType = attachment.contentType ?? 'image/png';
          if (!mimeType.startsWith('image/')) continue;

          // Загружаем изображение как base64
          const imgResponse = await fetch(attachment.url);
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');

          parts.push({
            inlineData: { data: base64, mimeType },
          });
        }
      }

      if (text) parts.push({ text });

      const response = await chat.sendMessage({ message: parts });
      const reply = response.text;

      // Сохраняем в историю только текст (изображения не сериализуем)
      const historyText = text || '[изображение]';
      addToGeminiHistory(bananaHistory, userId, 'user', historyText);
      addToGeminiHistory(bananaHistory, userId, 'model', reply);

      await sendReplyFree(message, reply);
    } catch (e) {
      console.error(`Banana API error: ${e.constructor.name}: ${e.message}`);
      await message.reply(`❌ Ошибка Banana: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !tokens ───────────────────────────────────────────────
  if (content === '!tokens') {
    const remaining = getRequests(userId);
    await message.reply(`🔑 У вас осталось **${remaining}** запросов.`);
    return;
  }

  // ── !cclear ───────────────────────────────────────────────
  if (content === '!cclear') {
    clearHistory(userId);
    geminiHistory.delete(userId);
    bananaHistory.delete(userId);
    await message.reply('🗑️ История всех ваших чатов очищена.');
    return;
  }

  // ── !cgive <число> [@user] ────────────────────────────────
  if (content.startsWith('!cgive')) {
    if (userId !== ADMIN_ID) {
      await message.reply('❌ У вас нет доступа к этой команде.');
      return;
    }

    const parts = content.split(/\s+/);
    const amount = parseInt(parts[1]);

    if (!amount || amount <= 0) {
      await message.reply('❌ Укажите корректное число запросов.');
      return;
    }

    let target = message.mentions.members?.first() ?? null;

    if (!target && message.reference) {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      target = ref.member ?? ref.author;
    }

    if (!target) {
      await message.reply('❌ Укажите пользователя: `!cgive <число> @user` или ответьте на сообщение.');
      return;
    }

    const targetId = target.id ?? target.user?.id;
    const current = getRequests(targetId);
    setRequests(targetId, current + amount);

    await message.reply(`✅ Пользователю ${target.toString()} выдано **${amount}** запросов. Всего: **${current + amount}**`);
    return;
  }
});

// ─── Запуск ──────────────────────────────────────────────────
client.once('ready', () => {
  const claudeKey = process.env.ANTHROPIC_API_KEY ?? 'НЕ НАЙДЕН';
  const codexKey = process.env.CODEX_API_KEY ?? 'НЕ НАЙДЕН';
  const geminiKey = process.env.GEMINI_API_KEY ?? 'НЕ НАЙДЕН';
  console.log(`✅ Бот запущен как ${client.user.tag}`);
  console.log(claudeKey !== 'НЕ НАЙДЕН' ? `Claude Key: ${claudeKey.slice(0, 20)}...` : 'Claude Key: НЕ НАЙДЕН');
  console.log(codexKey !== 'НЕ НАЙДЕН' ? `Codex Key: ${codexKey.slice(0, 20)}...` : 'Codex Key: НЕ НАЙДЕН');
  console.log(geminiKey !== 'НЕ НАЙДЕН' ? `Gemini Key: ${geminiKey.slice(0, 20)}...` : 'Gemini Key: НЕ НАЙДЕН');
});

client.login(process.env.DISCORD_TOKEN);
