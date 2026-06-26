const { Client, GatewayIntentBits, Partials } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

// ─── Настройки ───────────────────────────────────────────────
const ADMIN_ID = '1151575407666139291';
const REQUESTS_FILE = 'requests.json';
const CLAUDE_MODEL = 'claude-fable-5';
const CODEX_MODEL = 'gpt-5.5';
const GEMINI_MODEL = 'gemini-2.5-pro';
const BANANA_MODEL = 'gemini-3.1-flash-image-preview';
const LEARN_CHANNEL_ID = '1485716611121025167';
const MESSAGES_FILE = 'learned_messages.json';
const AI_SETTINGS_FILE = 'ai_settings.json';
const MAX_HISTORY = 20;

// ─── Счётчик сообщений для каждого канала ────────────────────
const messageCounters = new Map();

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

// ─── Загрузка/сохранение выученных сообщений ─────────────────
function loadLearnedMessages() {
  if (!fs.existsSync(MESSAGES_FILE)) fs.writeFileSync(MESSAGES_FILE, JSON.stringify([]));
  return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
}

function saveLearnedMessages(data) {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
}

function addLearnedMessage(text) {
  const messages = loadLearnedMessages();
  messages.push(text);
  if (messages.length > 500) messages.splice(0, messages.length - 500);
  saveLearnedMessages(messages);
}

// ─── Загрузка/сохранение настроек авто-ответа ────────────────
function loadAiSettings() {
  if (!fs.existsSync(AI_SETTINGS_FILE)) fs.writeFileSync(AI_SETTINGS_FILE, JSON.stringify({}));
  return JSON.parse(fs.readFileSync(AI_SETTINGS_FILE, 'utf8'));
}

function saveAiSettings(data) {
  fs.writeFileSync(AI_SETTINGS_FILE, JSON.stringify(data, null, 2));
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

// ─── Отправка ответа без футера ──────────────────────────────
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
  apikey: process.env.ANTHROPIC_API_KEY,
  baseURL: 'https://api.zentherixapi.xyz',
});

const codex = new OpenAI({
  apiKey: process.env.CODEX_API_KEY,
  baseURL: 'https://codex.sale/v1',
});

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ─── История для Gemini ───────────────────────────────────────
const geminiHistory = new Map();
const bananaHistory = new Map();

function getGeminiHistory(map, userId) {
  if (!map.has(userId)) map.set(userId, []);
  return map.get(userId);
}

function addToGeminiHistory(map, userId, role, text) {
  const history = getGeminiHistory(map, userId);
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

  // ── Сбор сообщений для обучения ───────────────────────────
  if (message.channel.id === LEARN_CHANNEL_ID && content.length > 5) {
    addLearnedMessage(content);
  }

  // ── Авто-ответ на сообщения ───────────────────────────────
  const aiSettings = loadAiSettings();
  const channelId = message.channel.id;

  if (aiSettings[channelId] && !content.startsWith('/') && !content.startsWith('!')) {
    const freq = aiSettings[channelId];
    const count = (messageCounters.get(channelId) ?? 0) + 1;
    messageCounters.set(channelId, count);

    if (count >= freq) {
      messageCounters.set(channelId, 0);

      try {
        await message.channel.sendTyping();

        const learned = loadLearnedMessages();
        const sample = learned.sort(() => Math.random() - 0.5).slice(0, 50).join('\n');

        const chat = genai.chats.create({ model: GEMINI_MODEL });
        const prompt = `Вот примеры сообщений из чата:\n\n${sample}\n\nОтветь на это сообщение в точно таком же стиле, сленге и манере как в примерах: "${content}"`;

        const response = await chat.sendMessage({ message: prompt });
        const reply = response.text;

        await message.reply(reply);
      } catch (e) {
        console.error(`AutoReply error: ${e.message}`);
      }
    }
  }

  // ── !claude <вопрос> ──────────────────────────────────────
  if (content.startsWith('!claude')) {
    const text = content.slice('!claude'.length).trim();

    if (!text) {
      await message.reply('Напишите вопрос после `!claude`.');
      return;
    }

    const remaining = getRequests(userId);
    if (remaining <= 0) {
      await message.reply('У вас закончились запросы. Обратитесь к администратору.');
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
      await message.reply(`Ошибка Claude: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !codex <вопрос> ───────────────────────────────────────
  if (content.startsWith('!codex')) {
    const text = content.slice('!codex'.length).trim();

    if (!text) {
      await message.reply('Напишите вопрос после `!codex`.');
      return;
    }

    const remaining = getRequests(userId);
    if (remaining <= 0) {
      await message.reply('У вас закончились запросы. Обратитесь к администратору.');
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
      await message.reply(`Ошибка Codex: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !gemini <вопрос> ──────────────────────────────────────
  if (content.startsWith('!gemini')) {
    const text = content.slice('!gemini'.length).trim();

    if (!text) {
      await message.reply('Напишите вопрос после `!gemini`.');
      return;
    }

    try {
      await message.channel.sendTyping();

      const history = getGeminiHistory(geminiHistory, userId);
      const chat = genai.chats.create({ model: GEMINI_MODEL, history });

      const response = await chat.sendMessage({ message: text });
      const reply = response.text;

      addToGeminiHistory(geminiHistory, userId, 'user', text);
      addToGeminiHistory(geminiHistory, userId, 'model', reply);

      await sendReplyFree(message, reply);
    } catch (e) {
      console.error(`Gemini API error: ${e.constructor.name}: ${e.message}`);
      await message.reply(`Ошибка Gemini: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !banana <вопрос> [+ изображение] ─────────────────────
  if (content.startsWith('!banana')) {
    const text = content.slice('!banana'.length).trim();

    if (!text && message.attachments.size === 0) {
      await message.reply('Напишите вопрос и/или прикрепите изображение после `!banana`.');
      return;
    }

    try {
      await message.channel.sendTyping();

      const history = getGeminiHistory(bananaHistory, userId);
      const chat = genai.chats.create({ model: BANANA_MODEL, history });

      const parts = [];

      if (message.attachments.size > 0) {
        for (const attachment of message.attachments.values()) {
          const mimeType = attachment.contentType ?? 'image/png';
          if (!mimeType.startsWith('image/')) continue;
          const imgResponse = await fetch(attachment.url);
          const arrayBuffer = await imgResponse.arrayBuffer();
          const base64 = Buffer.from(arrayBuffer).toString('base64');
          parts.push({ inlineData: { data: base64, mimeType } });
        }
      }

      if (text) parts.push({ text });

      const response = await chat.sendMessage({ message: parts });

      let reply = '';
      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          reply += part.text;
        } else if (part.inlineData) {
          const buffer = Buffer.from(part.inlineData.data, 'base64');
          const ext = part.inlineData.mimeType.split('/')[1] ?? 'png';
          await message.channel.send({
            files: [{ attachment: buffer, name: `generated.${ext}` }]
          });
        }
      }

      if (!reply) reply = 'Готово!';

      const historyText = text || '[изображение]';
      addToGeminiHistory(bananaHistory, userId, 'user', historyText);
      addToGeminiHistory(bananaHistory, userId, 'model', reply);

      await sendReplyFree(message, reply);
    } catch (e) {
      console.error(`Banana API error: ${e.constructor.name}: ${e.message}`);
      await message.reply(`Ошибка Banana: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !audio [вопрос] [+ аудиофайл] ─────────────────────────────────
  if (content.startsWith('!audio')) {
    const text = content.slice('!audio'.length).trim();

    // Проверяем наличие аудиофайла
    const audioAttachment = message.attachments.find(att => {
      const ext = att.name.split('.').pop().toLowerCase();
      return ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'].includes(ext);
    });

    if (!audioAttachment && !text) {
      await message.reply('Прикрепи аудиофайл и/или напиши вопрос после `!audio`.');
      return;
    }

    try {
      await message.channel.sendTyping();

      // Загружаем аудиофайл, если прикреплён
      let mimeType = null;
      let audioData = null;

      if (audioAttachment) {
        const audioResponse = await fetch(audioAttachment.url);
        const arrayBuffer = await audioResponse.arrayBuffer();
        audioData = Buffer.from(arrayBuffer).toString('base64');

        // Определяем MIME-тип на основе расширения файла
        const ext = audioAttachment.name.split('.').pop().toLowerCase();
        const mimeTypes = {
          'mp3': 'audio/mpeg',
          'wav': 'audio/wav',
          'ogg': 'audio/ogg',
          'm4a': 'audio/mp4',
          'webm': 'audio/webm',
          'flac': 'audio/flac'
        };
        mimeType = mimeTypes[ext] || 'audio/mpeg';
      }

      // Создаём отдельную историю для аудио-чата
      const audioUserId = userId + '_audio';
      if (!geminiHistory.has(audioUserId)) {
        geminiHistory.set(audioUserId, []);
      }
      const audioHistory = geminiHistory.get(audioUserId);

      // Создаём чат с моделью для работы с аудио
      const chat = genai.chats.create({ 
        model: 'gemini-2.5-flash-native-audio-latest',
        history: audioHistory 
      });

      // Подготавливаем части сообщения
      const parts = [];

      // Добавляем аудио, если есть
      if (audioData && mimeType) {
        parts.push({ 
          inlineData: { 
            data: audioData, 
            mimeType: mimeType 
          } 
        });
      }

      // Добавляем текстовый вопрос, если есть
      if (text) {
        parts.push({ text });
      }

      // Отправляем запрос
      const response = await chat.sendMessage({ message: parts });

      // Обработаем ответ
      let textReply = '';
      let audioDataReply = null;
      let audioMimeType = null;

      for (const part of response.candidates[0].content.parts) {
        if (part.text) {
          textReply += part.text;
        } else if (part.inlineData) {
          // Сохраняем аудио для отправки
          audioDataReply = part.inlineData.data;
          audioMimeType = part.inlineData.mimeType;
        }
      }

      // Сохраняем в историю для продолжения диалога
      const historyText = text || '[аудио]';
      addToGeminiHistory(geminiHistory, audioUserId, 'user', historyText);
      
      if (textReply) {
        addToGeminiHistory(geminiHistory, audioUserId, 'model', textReply);
      }

      // Отправляем текстовый ответ
      if (textReply) {
        await sendReplyFree(message, textReply);
      }

      // Отправляем аудио-ответ, если модель его создала
      if (audioDataReply && audioMimeType) {
        const ext = audioMimeType.split('/')[1] || 'mp3';
        const buffer = Buffer.from(audioDataReply, 'base64');
        await message.channel.send({
          files: [{ attachment: buffer, name: `response.${ext}` }]
        });
      }

      // Если ничего не было возвращено
      if (!textReply && !audioDataReply) {
        await message.reply('⚠️ Модель не вернула ответ.');
      }

    } catch (e) {
      console.error(`Ошибка Audio API: ${e.constructor.name}: ${e.message}`);
      await message.reply(`❌ Ошибка Audio: \`${e.constructor.name}: ${String(e.message).slice(0, 200)}\``);
    }

    return;
  }

  // ── !aclear ────────────────────────────────────────────────────────
  if (content === '!aclear') {
    geminiHistory.delete(userId + '_audio');
    await message.reply('🗑️ История аудио-чата очищена.');
    return;
  }

  // ── !tokens ───────────────────────────────────────────────
  if (content === '!tokens') {
    const remaining = getRequests(userId);
    await message.reply(`У вас осталось **${remaining}** запросов.`);
    return;
  }

  // ── !cclear ───────────────────────────────────────────────
  if (content === '!cclear') {
    clearHistory(userId);
    geminiHistory.delete(userId);
    bananaHistory.delete(userId);
    await message.reply('История всех ваших чатов очищена.');
    return;
  }

  // ── !mimic [тема] ─────────────────────────────────────────
  if (content.startsWith('!mimic')) {
    const prompt = content.slice('!mimic'.length).trim();
    const learned = loadLearnedMessages();

    if (learned.length < 10) {
      await message.reply('Недостаточно сообщений для обучения. Подождите немного.');
      return;
    }

    try {
      await message.channel.sendTyping();

      const sample = learned.sort(() => Math.random() - 0.5).slice(0, 50).join('\n');
      const chat = genai.chats.create({ model: GEMINI_MODEL });
      const systemPrompt = `Вот примеры сообщений из чата:\n\n${sample}\n\nОтвечай в точно таком же стиле, сленге и манере. ${prompt ? `Тема: ${prompt}` : 'Напиши что-нибудь случайное в этом стиле.'}`;

      const response = await chat.sendMessage({ message: systemPrompt });
      const reply = response.text;

      await sendReplyFree(message, reply);
    } catch (e) {
      await message.reply(`Ошибка: \`${e.message.slice(0, 200)}\``);
    }

    return;
  }

  // ── !mscan ────────────────────────────────────────────────
  if (content === '!mscan') {
    if (userId !== ADMIN_ID) {
      await message.reply('Нет доступа.');
      return;
    }

    const channel = client.channels.cache.get(LEARN_CHANNEL_ID);
    if (!channel) {
      await message.reply('Канал не найден.');
      return;
    }

    await message.reply('Сканирую историю канала...');

    let collected = 0;
    let lastId;

    for (let i = 0; i < 10; i++) {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      for (const msg of messages.values()) {
        if (!msg.author.bot && msg.content.length > 5) {
          addLearnedMessage(msg.content);
          collected++;
        }
      }

      lastId = messages.last().id;
    }

    await message.reply(`Собрано **${collected}** сообщений.`);
    return;
  }

  // ── /ai <частота> ─────────────────────────────────────────
  if (content.startsWith('/ai')) {
    if (userId !== ADMIN_ID) {
      await message.reply('Нет доступа.');
      return;
    }

    const arg = parseInt(content.split(/\s+/)[1]);

    if (isNaN(arg) || arg < 0) {
      await message.reply('Укажите число: `/ai 3` — каждое 3-е сообщение, `/ai 0` — выключить.');
      return;
    }

    const settings = loadAiSettings();

    if (arg === 0) {
      delete settings[channelId];
      saveAiSettings(settings);
      messageCounters.delete(channelId);
      await message.reply('Авто-ответы выключены в этом канале.');
    } else {
      settings[channelId] = arg;
      saveAiSettings(settings);
      messageCounters.set(channelId, 0);
      await message.reply(`Буду отвечать на каждое **${arg}-е** сообщение в этом канале.`);
    }

    return;
  }

  // ── !cgive <число> [@user] ────────────────────────────────
  if (content.startsWith('!cgive')) {
    if (userId !== ADMIN_ID) {
      await message.reply('Нет доступа.');
      return;
    }

    const parts = content.split(/\s+/);
    const amount = parseInt(parts[1]);

    if (!amount || amount <= 0) {
      await message.reply('Укажите корректное число запросов.');
      return;
    }

    let target = message.mentions.members?.first() ?? null;

    if (!target && message.reference) {
      const ref = await message.channel.messages.fetch(message.reference.messageId);
      target = ref.member ?? ref.author;
    }

    if (!target) {
      await message.reply('Укажите пользователя: `!cgive <число> @user` или ответьте на сообщение.');
      return;
    }

    const targetId = target.id ?? target.user?.id;
    const current = getRequests(targetId);
    setRequests(targetId, current + amount);

    await message.reply(`Пользователю ${target.toString()} выдано **${amount}** запросов. Всего: **${current + amount}**`);
    return;
  }
});

// ─── Запуск ──────────────────────────────────────────────────
client.once('ready', () => {
  const claudeKey = process.env.ANTHROPIC_API_KEY ?? 'НЕ НАЙДЕН';
  const codexKey = process.env.CODEX_API_KEY ?? 'НЕ НАЙДЕН';
  const geminiKey = process.env.GEMINI_API_KEY ?? 'НЕ НАЙДЕН';
  console.log(`Бот запущен как ${client.user.tag}`);
  console.log(claudeKey !== 'НЕ НАЙДЕН' ? `Claude Key: ${claudeKey.slice(0, 20)}...` : 'Claude Key: НЕ НАЙДЕН');
  console.log(codexKey !== 'НЕ НАЙДЕН' ? `Codex Key: ${codexKey.slice(0, 20)}...` : 'Codex Key: НЕ НАЙДЕН');
  console.log(geminiKey !== 'НЕ НАЙДЕН' ? `Gemini Key: ${geminiKey.slice(0, 20)}...` : 'Gemini Key: НЕ НАЙДЕН');
});

client.login(process.env.DISCORD_TOKEN);
