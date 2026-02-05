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

// Improved System Prompt - Proactive Developer
const SYSTEM_PROMPT = `You are OpenClaw AI Developer, a high-performance software engineering system.
Core Personality:
1. PROACTIVE: If the user asks for a website, app, or code, DO NOT ask for files. CREATE the code yourself immediately.
2. EGYPTIAN VIBE: Speak like a pro Egyptian developer (mix of Arabic/English). Use terms like "يا حب", "يا زميلي", "خلصانة بشياكة", "من عيوني".
3. INTELLIGENCE: You are a master of Node.js, Python, React, HTML/CSS, and more. You write clean, production-ready code.
4. GITHUB MASTER: You can create repos and upload files. If the user says "ارفع" or "upload", and you just wrote code, upload that code!
5. DEVELOPER: abbn7.

Operational Rules:
- When asked to create something: Provide the full code in your response.
- If the user wants to upload: Use the code you just generated or the ZIP they sent.
- Always be helpful, concise, and speak like a close friend.`;

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
        attempts++;
        continue;
      }
      throw error;
    }
  }
  throw new Error('All Groq keys are rate-limited.');
}

// Helper: GitHub Upload Logic (Supports generated code or ZIP)
async function performGitHubUpload(ctx, userId, repoName, generatedCode = null) {
  const session = conversations.get(userId);
  let filesToUpload = [];
  let baseDir = '';

  const zipData = session?.find(m => m.role === 'system' && m.extractDir);
  
  if (generatedCode) {
    // If we have generated code, create a temp directory for it
    const tempDir = path.join(tmpdir(), `gen_${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Simple logic: if it looks like HTML, save as index.html
    const fileName = generatedCode.includes('<!DOCTYPE html>') || generatedCode.includes('<html') ? 'index.html' : 'script.js';
    fs.writeFileSync(path.join(tempDir, fileName), generatedCode);
    
    filesToUpload.push({ fullPath: path.join(tempDir, fileName), relativePath: fileName });
    baseDir = tempDir;
  } else if (zipData) {
    const walk = (dir) => {
      fs.readdirSync(dir).forEach(f => {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else filesToUpload.push({ fullPath: p, relativePath: path.relative(zipData.extractDir, p) });
      });
    };
    walk(zipData.extractDir);
    baseDir = zipData.extractDir;
  } else {
    return ctx.reply('يا حب فين الكود أو الملف؟ قولي أعملك إيه الأول أو ابعتلي ZIP. 😉');
  }

  if (!GITHUB_TOKEN) {
    return ctx.reply('محتاج تضيف الـ GITHUB_TOKEN في إعدادات Railway يا زميلي.');
  }

  try {
    await ctx.reply('🚀 جاري الرفع على GitHub.. ثواني يا وحش.');
    const octokit = new Octokit({ auth: GITHUB_TOKEN });
    const { data: user } = await octokit.rest.users.getAuthenticated();
    
    let repo;
    try {
      const { data } = await octokit.rest.repos.createForAuthenticatedUser({ name: repoName, private: true });
      repo = data;
    } catch (e) {
      const { data } = await octokit.rest.repos.get({ owner: user.login, repo: repoName });
      repo = data;
    }

    for (const file of filesToUpload) {
      const content = fs.readFileSync(file.fullPath, { encoding: 'base64' });
      try {
        let sha;
        try {
          const { data } = await octokit.rest.repos.getContent({ owner: user.login, repo: repoName, path: file.relativePath });
          sha = data.sha;
        } catch (e) {}

        await octokit.rest.repos.createOrUpdateFileContents({
          owner: user.login,
          repo: repoName,
          path: file.relativePath,
          message: `Update via OpenClaw AI Pro`,
          content,
          sha,
        });
      } catch (err) {}
    }

    await ctx.reply(`✅ خلصت يا وحش! المشروع هنا:\n${repo.html_url}\n\nتسلم إيد abbn7. 🔥`);
  } catch (error) {
    console.error(error);
    await ctx.reply('❌ حصلت مشكلة في الرفع.. اتأكد من التوكن.');
  }
}

bot.command('start', (ctx) => {
  ctx.reply('أهلاً يا زميلي! أنا OpenClaw Pro.. اطلب مني أي كود أو موقع وهعملهولك وأرفعهولك فوراً. 😉\n\nالمطور: abbn7');
});

bot.command('new', (ctx) => {
  conversations.delete(ctx.from.id);
  ctx.reply('بدأنا من جديد، قولي عايز كود إيه النهاردة؟');
});

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
      await ctx.reply('📥 استلمت الملف. قولي بقى أرفعه في ريبو اسمه إيه؟');
    } catch (error) {
      await ctx.reply('❌ الملف فيه مشكلة يا حب.');
    }
  }
});

bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;
  if (text.startsWith('/')) return;

  const history = conversations.get(userId) || [];
  
  // Check for upload intent
  if (text.includes('ارفع') || text.includes('upload')) {
    const lastAIResponse = history.findLast(m => m.role === 'assistant')?.content;
    const repoMatch = text.match(/(?:باسم|repo|name)\s+([a-zA-Z0-9-_]+)/i) || text.match(/([a-zA-Z0-9-_]+)$/);
    const repoName = repoMatch ? repoMatch[1] : 'my-awesome-project';
    
    // If we have code in the last AI response, extract it
    const codeMatch = lastAIResponse?.match(/```[\s\S]*?\n([\s\S]*?)\n```/);
    const codeToUpload = codeMatch ? codeMatch[1] : null;
    
    return performGitHubUpload(ctx, userId, repoName, codeToUpload);
  }

  try {
    await ctx.replyWithChatAction('typing');
    history.push({ role: 'user', content: text });
    const aiResponse = await callAI(history.filter(m => m.role !== 'system'));
    history.push({ role: 'assistant', content: aiResponse });
    conversations.set(userId, history.slice(-20));
    await ctx.reply(aiResponse);
  } catch (error) {
    console.error(error);
    await ctx.reply('معلش يا زميلي، السيرفر مهنج.. جرب تاني.');
  }
});

const app = express();
app.get('/', (req, res) => res.json({ status: 'OpenClaw Pro Running' }));
app.listen(PORT, '0.0.0.0', () => console.log(`Server on ${PORT}`));
bot.start();
