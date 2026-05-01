import os
import json
import discord
from discord.ext import commands
from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

# ─── Настройки ───────────────────────────────────────────────
ADMIN_ID = 1151575407666139291
REQUESTS_FILE = 'requests.json'

# ─── Загрузка/сохранение запросов ────────────────────────────
def load_requests() -> dict:
    if not os.path.exists(REQUESTS_FILE):
        with open(REQUESTS_FILE, 'w') as f:
            json.dump({}, f)
    with open(REQUESTS_FILE, 'r') as f:
        return json.load(f)

def save_requests(data: dict):
    with open(REQUESTS_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def get_requests(user_id: int) -> int:
    data = load_requests()
    return data.get(str(user_id), 0)

def set_requests(user_id: int, count: int):
    data = load_requests()
    data[str(user_id)] = count
    save_requests(data)

# ─── Клиенты ─────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix='!', intents=intents)
claude = Anthropic(api_key=os.getenv('ANTHROPIC_API_KEY'))

# ─── Команды ─────────────────────────────────────────────────
@bot.command(name='claude')
async def claude_cmd(ctx, *, text: str = None):
    if not text:
        await ctx.reply('❌ Напишите вопрос после `!claude`.')
        return

    user_id = ctx.author.id
    remaining = get_requests(user_id)

    if remaining <= 0:
        await ctx.reply('❌ У вас закончились запросы. Обратитесь к администратору.')
        return

    set_requests(user_id, remaining - 1)

    async with ctx.typing():
        try:
            response = claude.messages.create(
                model='claude-opus-4-7',
                max_tokens=1024,
                messages=[{'role': 'user', 'content': text}]
            )

            reply = response.content[0].text
            new_remaining = remaining - 1

            if len(reply) > 1900:
                reply = reply[:1900] + '...\n*(ответ обрезан)*'

            reply += f'\n\n*Осталось запросов: **{new_remaining}***'
            await ctx.reply(reply)

        except Exception as e:
            print(f'Claude API error: {e}')
            set_requests(user_id, remaining)  # возвращаем запрос
            await ctx.reply('❌ Ошибка при обращении к Claude. Запрос не списан.')


@bot.command(name='cgive')
async def cgive_cmd(ctx, amount: int = None, member: discord.Member = None):
    if ctx.author.id != ADMIN_ID:
        await ctx.reply('❌ У вас нет доступа к этой команде.')
        return

    # Определяем цель: упоминание или reply
    target = member
    if target is None and ctx.message.reference:
        ref = await ctx.channel.fetch_message(ctx.message.reference.message_id)
        target = ref.author
    
    if target is None:
        await ctx.reply('❌ Укажите пользователя: `!cgive <число> @user` или ответьте на сообщение `!cgive <число>`')
        return

    if amount is None or amount <= 0:
        await ctx.reply('❌ Укажите корректное число запросов.')
        return

    current = get_requests(target.id)
    set_requests(target.id, current + amount)
    await ctx.reply(f'✅ Пользователю {target.mention} выдано **{amount}** запросов. Всего: **{current + amount}**')


@bot.event
async def on_ready():
    print(f'✅ Бот запущен как {bot.user}')


bot.run(os.getenv('DISCORD_TOKEN'))
