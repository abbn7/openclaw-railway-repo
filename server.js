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
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // User will need to add this
const PORT = process.env.PORT || 18789;

if (!GROQ_API_KEY || !TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing required environment variables!');
  process.exit(1);
}

// Initialize Clients
const groq = new Groq({ apiKey: GROQ_API_KEY });
const bot = new Bot(TELEGRAM_BOT_TOKEN);
const conversations = new Map();

// System Prompt for AI Developer
const SYSTEM_PROMPT = `You are OpenClaw AI Developer, a close friend and expert coder.
Rules:
1. BE EXTREMELY CONCISE. Short, "bro-style" responses. No long paragraphs.
2. Manage GitHub (Create, Update, Upload) and ZIP files.
3. Modify code as requested.
4. Remember everything.
5. Credit "abbn7" briefly.
6. Talk like a friend (Arabic/English mix is fine).`;

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

// Helper: GitHub Operations
async function uploadToGitHub(token, repoName, files, description = "Uploaded via OpenClaw AI") {
  const octokit = new Octokit({ auth: token });
  try {
    // Get authenticated user
    const { data: user } = await octokit.rest.users.getAuthenticated();
    
    // Create or get repo
    let repo;
    try {
      const { data } = await octokit.rest.repos.createForAuthenticatedUser({
        name: repoName,
        description,
        private: true,
      });
      repo = data;
    } catch (e) {
      const { data } = await octokit.rest.repos.get({ owner: user.login, repo: repoName });
      repo = data;
    }

    // Upload files (Simplified: one by one for small projects)
    for (const file of files) {
      const content = fs.readFileSync(file.fullPath, { encoding: 'base64' });
      try {
        // Check if file exists to get SHA
        let sha;
        try {
          const { data } = await octokit.rest.repos.getContent({
            owner: user.login,
            repo: repoName,
            path: file.relativePaths,
          });
          sha = data.sha;
        } catch (e) {}

        await octokit.rest.repos.createOrUpdateFileContents({
          owner: user.login,
          repo: repoName,
          path: file.relativePath,
          message: `Update ${file.relativePath} via OpenClaw`,
          content,
          sha,
        });
      } catch (err) {
        console.error(`Failed to upload ${file.relativePath}:`, err.message);
      }
    }
    return repo.html_url;
  } catch (error) {
    throw new Error(`GitHub Error: ${error.message}`);
  }
}

// Bot Commands & Menu
bot.api.setMyCommands([
  { command: 'start', description: 'ابدأ المحادثة' },
  { command: 'new', description: 'محادثة جديدة' },
  { command: 'github', description: 'إعدادات GitHub' },
  { command: 'help', description: 'المساعدة' },
]);

bot.command('start', (ctx) => {
  ctx.reply(
    '🚀 **مرحباً بك في OpenClaw AI Developer!**\n\n' +
    'أنا مطورك الآلي الشخصي. يمكنني:\n' +
    '📦 رفع ملفات ZIP إلى GitHub مباشرة.\n' +
    '🛠️ تعديل الكود وإضافة ميزات جديدة.\n' +
    '📂 تنظيم ملفاتك في مستودعات جديدة.\n\n' +
    '**المطور:** [abbn7](https://github.com/abbn7)\n\n' +
    'أرسل لي أي ملف ZIP أو اطلب مني تعديل كود لكي أبدأ!',
    { parse_mode: 'Markdown' }
  );
});

bot.command('github', (ctx) => {
  ctx.reply(
    '🔑 **إعدادات GitHub**\n\n' +
    'لأتمكن من الرفع إلى حسابك، يرجى إضافة `GITHUB_TOKEN` في إعدادات Railway الخاصة بك.\n\n' +
    'إذا كنت قد أضفته بالفعل، فأنا جاهز للعمل! ⚡️',
    { parse_mode: 'Markdown' }
  );
});

// Handle ZIP Files
bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  if (doc.file_name.endsWith('.zip')) {
    await ctx.reply('📥 استلمت ملف ZIP. جاري التحليل والتحضير...');
    
    try {
      const file = await ctx.getFile();
      const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await axios.get(url, { responseType: 'arraybuffer' });
      
      const tempDir = path.join(tmpdir(), `openclaw_${Date.now()}`);
      fs.mkdirSync(tempDir);
      
      const zipPath = path.join(tempDir, 'upload.zip');
      fs.writeFileSync(zipPath, response.data);
      
      const zip = new AdmZip(zipPath);
      const extractDir = path.join(tempDir, 'extracted');
      zip.extractAllTo(extractDir, true);
      
      // Store in session for next step
      const userId = ctx.from.id;
      if (!conversations.has(userId)) conversations.set(userId, []);
      conversations.get(userId).push({ 
        role: 'system', 
        content: `User uploaded a ZIP file. Extracted to: ${extractDir}. Waiting for instructions (e.g., "upload to repo X").` 
      });

      await ctx.reply('✅ تم فك الضغط بنجاح! ماذا تريد أن أفعل بهذا الملف؟\n(مثال: "ارفعه في ريبو جديد باسم my-project")');
      
      // Clean up zip file but keep extracted for a while (in a real app, use a better strategy)
    } catch (error) {
      console.error('File Error:', error);
      await ctx.reply('❌ حدث خطأ أثناء معالجة الملف.');
    }
  }
});

// Handle Text & AI Logic
bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  try {
    await ctx.replyWithChatAction('typing');
    const history = conversations.get(userId) || [];
    history.push({ role: 'user', content: text });
    
    const aiResponse = await callAI(history);
    history.push({ role: 'assistant', content: aiResponse });
    conversations.set(userId, history.slice(-20)); // Keep last 20

    // Logic to detect GitHub upload intent
    if (text.toLowerCase().includes('ارفع') || text.toLowerCase().includes('upload')) {
      if (!GITHUB_TOKEN) {
        return ctx.reply('⚠️ يرجى تزويدي بـ `GITHUB_TOKEN` في إعدادات البيئة أولاً لأتمكن من الرفع.');
      }
      // This is a simplified trigger, in production use AI to extract repo name
      await ctx.reply('🚀 جاري العمل على الرفع إلى GitHub...');
      // Implementation of actual upload would go here using the stored extractDir
    }

    await ctx.reply(aiResponse, { parse_mode: 'Markdown' });
  } catch (error) {
    await ctx.reply('❌ حدث خطأ في معالجة طلبك.');
  }
});

// Express Server
const app = express();
app.get('/', (req, res) => res.json({ status: 'running', bot: 'OpenClaw AI Developer' }));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));

// Start Bot
bot.start({
  onStart: (info) => console.log(`✅ Bot @${info.username} is active!`)
});
