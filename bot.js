const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = '1151575407666139291';
const REQUESTS_FILE = 'requests.json';
const MODEL = 'claude-opus-4-7';
const MAX_HISTORY = 20; // максимум сообщений в истории на пользователя

// ─── История чатов (в памяти) ────────────────────────────────
const chatHistory = new Map(); // userId -> [{role, content}]

function getHistory(userId) {
  if (!chatHistory.has(userId)) chatHistory.set(userId, []);
  return chatHistory.get(userId);
}

function addToHistory(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  // Обрезаем до MAX_HISTORY сообщений (пар)
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
    // Ищем последний перенос строки в пределах лимита
    let splitAt = text.lastIndexOf('\n', maxLength);
    if (splitAt === -1) splitAt = maxLength;
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt).trimStart();
  }
  return parts;
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
  baseURL: 'https://api.gngn.my',
});

// ─── Обработка сообщений ─────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // !claude <вопрос>
  if (content.startsWith('!claude')) {
    const text = content.slice('!claude'.length).trim();

    if (!text) {
      await message.reply('❌ Напишите вопрос после `!claude`.');
      return;
    }

    const userId = message.author.id;
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
        model: MODEL,
        max_tokens: 131072,
        messages: getHistory(userId),
      });

      const response = await stream.finalMessage();
      const reply = response.content[0].text;
      const newRemaining = remaining - 1;

      // Сохраняем ответ в историю
      addToHistory(userId, 'assistant', reply);

      const footer = `\n\n*Осталось запросов: **${newRemaining}***`;

      if (reply.length > 1900) {
        // Разбиваем на части и отправляем последовательно
        const parts = splitMessage(reply);
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          if (i === 0) {
            await message.reply(parts[i] + (isLast ? footer : ''));
          } else {
            await message.channel.send(parts[i] + (isLast ? footer : ''));
          }
        }
      } else {
        await message.reply(reply + footer);
      }
    } catch (e) {
      console.error(`Claude API error: ${e.constructor.name}: ${e.message}`);
      // Откатываем сообщение пользователя из истории при ошибке
      const history = getHistory(userId);
      if (history.at(-1)?.role === 'user') history.pop();
      setRequests(userId, remaining);
      await message.reply(`❌ Ошибка: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // !tokens
  if (content === '!tokens') {
    const remaining = getRequests(message.author.id);
    await message.reply(`🔑 У вас осталось **${remaining}** запросов.`);
    return;
  }

  // !cclear — очистить историю чата
  if (content === '!cclear') {
    clearHistory(message.author.id);
    await message.reply('🗑️ История вашего чата очищена.');
    return;
  }

  // !cgive <число> [@user]
  if (content.startsWith('!cgive')) {
    if (message.author.id !== ADMIN_ID) {
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
  const key = process.env.ANTHROPIC_API_KEY ?? 'НЕ НАЙДЕН';
  console.log(`✅ Бот запущен как ${client.user.tag}`);
  console.log(key !== 'НЕ НАЙДЕН' ? `API Key: ${key.slice(0, 20)}...` : 'API Key: НЕ НАЙДЕН');
});

client.login(process.env.DISCORD_TOKEN);
