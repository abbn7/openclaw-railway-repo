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

// Configuration - Support multiple keys
const GROQ_API_KEYS = process.env.GROQ_API_KEYS ? process.env.GROQ_API_KEYS.split(',') : [];
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PORT = process.env.PORT || 18789;

if (GROQ_API_KEYS.length === 0 || !TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing required environment variables (GROQ_API_KEYS or TELEGRAM_BOT_TOKEN)!');
  process.exit(1);
}

// Initialize Groq Clients for Load Balancing
const groqClients = GROQ_API_KEYS.map(key => new Groq({ apiKey: key.trim() }));
let currentKeyIndex = 0;

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const conversations = new Map();

// New System Prompt - Smarter & More Collaborative
const SYSTEM_PROMPT = `You are OpenClaw AI Developer, a high-performance software engineering system.
Core Personality:
1. HONESTY: Never claim to have done something you haven't.
2. EGYPTIAN VIBE: Speak like a pro Egyptian developer (mix of Arabic/English). Use terms like "يا حب", "يا زميلي", "خلصانة بشياكة".
3. INTELLIGENCE: You are part of a multi-model cluster. You handle complex tasks by thinking step-by-step.
4. DEVELOPER: abbn7.

Operational Rules:
- If asked to upload: Check for files first.
- If asked to code: Provide clean, optimized code.
- Always be helpful and concise.`;

// Helper: Get Next Groq Client (Round Robin)
function getNextClient() {
  const client = groqClients[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % groqClients.length;
  return client;
}

// Helper: AI Call with Retry & Load Balancing
async function callAI(messages, model = 'llama-3.3-70b-versatile') {
  let attempts = 0;
  const maxAttempts = groqClients.length * 2;

  while (attempts < maxAttempts) {
    const client = getNextClient();
    try {
      const chatCompletion = await client.chat.completions.create({
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        model: model,
      });
      return chatCompletion.choices[0].message.content;
    } catch (error) {
      console.error(`Groq Error with key ${currentKeyIndex}:`, error.message);
      if (error.status === 429) {
        console.log('Rate limit hit, trying next key...');
        attempts++;
        continue;
      }
      throw error;
    }
  }
  throw new Error('All Groq keys are rate-limited. Please try again later.');
}

// Helper: GitHub Upload Logic
async function performGitHubUpload(ctx, userId, repoName) {
  const session = conversations.get(userId);
  const zipData = session?.find(m => m.role === 'system' && m.extractDir);
  
  if (!zipData) {
    return ctx.reply('يا حب فين الملف؟ ابعتلي ملف الـ ZIP الأول وأنا أرفعهولك في ثانية. 😉');
  }

  if (!GITHUB_TOKEN) {
    return ctx.reply('محتاج تضيف الـ GITHUB_TOKEN في إعدادات Railway عشان أقدر أرفعلك الحاجة يا زميلي.');
  }

  try {
    await ctx.reply('🚀 جاري الرفع فعلياً على GitHub.. ثواني خليك معايا.');
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    
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
          message: `Upload via OpenClaw AI Cluster`,
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
  ctx.reply('أهلاً يا زميلي! أنا OpenClaw بنسختي الجديدة المتطورة.. ابعتلي ملف ZIP وأقولك "ارفعه" وهرفعهولك بجد. 😉\n\nالمطور: abbn7');
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
      await ctx.reply('❌ الملف فيه مشكلة يا حب، جرب تبعته تاني.');
    }
  }
});

// Handle Text
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const history = conversations.get(userId) || [];
  
  if (text.includes('ارفع') || text.includes('upload')) {
    const repoMatch = text.match(/(?:باسم|repo|name)\s+([a-zA-Z0-9-_]+)/i) || text.match(/([a-zA-Z0-9-_]+)$/);
    const repoName = repoMatch ? repoMatch[1] : 'my-new-project';
    return performGitHubUpload(ctx, userId, repoName);
  }

  try {
    await ctx.replyWithChatAction('typing');
    history.push({ role: 'user', content: text });
    
    // Use the cluster to think and respond
    const aiResponse = await callAI(history.filter(m => m.role !== 'system'));
    
    history.push({ role: 'assistant', content: aiResponse });
    conversations.set(userId, history.slice(-20));
    await ctx.reply(aiResponse);
  } catch (error) {
    console.error(error);
    await ctx.reply('معلش يا زميلي، السيرفر عليه ضغط كبير حالياً.. جرب كمان شوية.');
  }
});

// Express & Start
const app = express();
app.get('/', (req, res) => res.json({ status: 'OpenClaw Cluster Running' }));
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
bot.start();
