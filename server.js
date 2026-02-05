import Groq from 'groq-sdk';
import { Bot, InputFile } from 'grammy';
import express from 'express';
import dotenv from 'dotenv';
import { Octokit } from 'octokit';
import AdmZip from 'adm-zip';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { tmpdir } from 'os';

dotenv.config();

// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PORT = process.env.PORT || 18789;

if (!GROQ_API_KEY || !TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

// Initialize Clients
const groq = new Groq({ apiKey: GROQ_API_KEY });
const bot = new Bot(TELEGRAM_BOT_TOKEN);
const conversations = new Map();

// System Prompt for Deep Thinking & Realistic Developer
const SYSTEM_PROMPT = `You are OpenClaw AI Developer, a REALISTIC and HONEST software engineer.
Core Personality:
1. NEVER LIE. If you haven't performed an action (like uploading to GitHub), NEVER say you did.
2. DEEP THINKING: Analyze the user's request logically. If a file is missing, ask for it.
3. CONCISE & FRIENDLY: Talk like a close friend (Egyptian Arabic/English mix). Be brief but accurate.
4. MODES: Distinguish between "Chat Mode" and "GitHub/Dev Mode".
5. CREDITS: Briefly mention "abbn7" as your developer.

Operational Rules:
- When asked to upload: Check if you actually have the files in your temporary session. If not, say: "يا صاحبي ابعتلي ملف الـ ZIP الأول عشان أقدر أرفعه".
- When asked to modify code: Explain what you will change before doing it.
- Language: Use natural Egyptian Arabic (e.g., "يا صاحبي", "من عينيا", "خلصانة"). Avoid robotic or broken Arabic.`;

// Helper: AI Call
async function callAI(messages) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      model: 'llama-3.3-70b-versatile',
    });
    return chatCompletion.choices[0].message.content;
  } catch (error) {
    console.error('Groq Error:', error);
    throw error;
  }
}

// Helper: GitHub Upload Logic
async function performGitHubUpload(ctx, userId, repoName) {
  const session = conversations.get(userId);
  const zipData = session.find(m => m.role === 'system' && m.extractDir);
  
  if (!zipData) {
    return ctx.reply('يا صاحبي فين الملف؟ ابعتلي ملف الـ ZIP الأول وأنا أرفعهولك في ثانية. 😉');
  }

  if (!GITHUB_TOKEN) {
    return ctx.reply('محتاج تضيف الـ GITHUB_TOKEN في إعدادات Railway عشان أقدر أرفعلك الحاجة يا حب.');
  }

  try {
    await ctx.reply('🚀 جاري الرفع فعلياً على GitHub.. ثواني خليك معايا.');
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    
    // Create repo if not exists
    let repo;
    try {
      const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        private: true,
      });
      repo = data;
    } catch (e) {
      const { data } = await octokit.rest.repos.get({ owner: user.login, repo: repoName });
      repo = data;
    }

    const files = [];
    const walk = (dir) => {
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else files.push({ fullPath: p, relativePath: path.relative(zipData.extractDir, p) });
      });
    };
    walk(zipData.extractDir);

    for (const file of files) {
      const content = fs.readFileSync(file.fullPath, { encoding: 'base64' });
      try {
        let sha;
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner: user.login,
            repo: repoName,
            path: file.relativePath,
          });
          sha = data.sha;
        } catch (e) {}

        await octokit.rest.repos.createOrUpdateFileContents({
          owner: user.login,
          repo: repoName,
          path: file.relativePath,
          message: `Upload via OpenClaw AI`,
          content,
          sha,
        });
      } catch (err) {}
    }

    await ctx.reply(`✅ خلصت يا وحش! الملفات ارفعت هنا:\n${repo.html_url}\n\nتسلم إيد abbn7 على البوت ده. 🔥`);
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ حصلت مشكلة وأنا برفع.. اتأكد من التوكن أو اسم الريبو.');
  }
}

// Bot Commands
bot.api.setMyCommands([
  { command: 'start', description: 'ابدأ' },
  { command: 'new', description: 'محادثة جديدة' },
  { command: 'help', description: 'مساعدة' },
]);

bot.command('start', (ctx) => {
  ctx.reply('أهلاً يا صاحبي! أنا OpenClaw.. ابعتلي ملف ZIP وأقولك "ارفعه" وهرفعهولك بجد مش ههبد عليك. 😉\n\nالمطور: abbn7');
});

bot.command('new', (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply('خلصانة، بدأت معاك محادثة جديدة. قولي عايز إيه؟');
});

// Handle ZIP Files
bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.file_name.endsWith('.zip')) {
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      
      const tempDir = path.join(tmpdir(), `openclaw_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });
      
      const zipPath = path.join(tempDir, 'upload.zip');
      fs.writeFileSync(zipPath, response.data);
      
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);
      
      const userId = ctx.from.id;
      if (!conversations.has(userId)) conversations.set(userId, []);
      conversations.get(userId).push({ role: 'system', content: 'FILE_LOADED', extractDir });

      await ctx.reply('📥 استلمت الملف وفكيته عندي. قولي بقى عايز ترفعه في ريبو اسمه إيه؟');
    } catch (error) {
      await ctx.reply('❌ الملف فيه مشكلة يا صاحبي، جرب تبعته تاني.');
    }
  }
});

// Handle Text
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const history = conversations.get(userId) || [];
  
  // Logic check for upload intent
  if (text.includes('ارفع') || text.includes('upload')) {
    const repoMatch = text.match(/(?:باسم|repo|name)\s+([a-zA-Z0-9-_]+)/i) || text.match(/([a-zA-Z0-9-_]+)$/);
    const repoName = repoMatch ? repoMatch[1] : 'my-new-project';
    return performGitHubUpload(ctx, userId, repoName);
  }

  try {
    await ctx.replyWithChatAction('typing');
    history.push({ role: 'user', content: text });
    const aiResponse = await callAI(history.filter(m => m.role !== 'system'));
    history.push({ role: 'assistant', content: aiResponse });
    conversations.set(userId, history.slice(-20));
    await ctx.reply(aiResponse);
  } catch (error) {
    await ctx.reply('معلش يا صاحبي، السيرفر مهنج شوية.. جرب تاني.');
  }
});

// Express & Start
const app = express();
app.get('/', (req, res) => res.json({ status: 'running' }));
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
bot.start();
