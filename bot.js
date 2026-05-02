const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = '1151575407666139291';
const REQUESTS_FILE = 'requests.json';
const MODEL = 'claude-opus-4-7';

// ─── Загрузка/сохранение запросов ────────────────────────────
function loadRequests() {
  if (!fs.existsSync(REQUESTS_FILE)) {
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify({}));
  }
  return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
}

function saveRequests(data) {
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(data, null, 2));
}

function getRequests(userId) {
  const data = loadRequests();
  return data[userId] ?? 0;
}

function setRequests(userId, count) {
  const data = loadRequests();
  data[userId] = count;
  saveRequests(data);
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
    try {
      await message.channel.sendTyping();
      const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 32768,
      messages: [{ role: 'user', content: text }],
    });

  const response = await stream.finalMessage();
  let reply = response.content[0].text;
  const newRemaining = remaining - 1;

      let reply = response.content[0].text;
      const newRemaining = remaining - 1;

      if (reply.length > 1900) {
        reply = reply.slice(0, 1900) + '...\n*(ответ обрезан)*';
      }

      reply += `\n\n*Осталось запросов: **${newRemaining}***`;
      await message.reply(reply);
    } catch (e) {
      console.error(`Claude API error: ${e.constructor.name}: ${e.message}`);
      setRequests(userId, remaining); // вернуть запрос при ошибке
      await message.reply(`❌ Ошибка: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

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

    // Цель — упоминание или reply
    let target = message.mentions.members?.first() ?? null;

    if (!target && message.reference) {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      target = ref.member ?? ref.author;
    }

    if (!target) {
      await message.reply('❌ Укажите пользователя: `!cgive <число> @user` или ответьте на сообщение `!cgive <число>`');
      return;
    }

    const targetId = target.id ?? target.user?.id;
    const targetMention = target.toString();
    const current = getRequests(targetId);
    setRequests(targetId, current + amount);

    await message.reply(`✅ Пользователю ${targetMention} выдано **${amount}** запросов. Всего: **${current + amount}**`);
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
