// index.js
// YourTranslator / LINE Bot
// 必要な環境変数：
// - LINE_CHANNEL_ACCESS_TOKEN
// - LINE_CHANNEL_SECRET
// - OPENAI_API_KEY
// - OPENAI_MODEL (任意。指定なければ gpt-4o-mini)
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY

const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

// ---------- 基本セットアップ ----------
const app = express();

// ※重要：app.use(express.json()) は付けない
// LINE middleware が署名検証で raw body を使うので、グローバル JSON パーサーは NG
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new Client(lineConfig);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// ---------- 言語判定（改良版） ----------
function detectLanguage(text) {
  const jaMatches = text.match(/[一-龯ぁ-んァ-ン]/g) || [];
  const enMatches = text.match(/[A-Za-z]/g) || [];

  const jaCount = jaMatches.length;
  const enCount = enMatches.length;

  if (jaCount > 0 && enCount === 0) return 'ja';
  if (enCount > 0 && jaCount === 0) return 'en';

  if (jaCount > 0 && enCount > 0) {
    const total = jaCount + enCount;
    const enRatio = enCount / total;

    // DB / API など英字ちょい混じりは日本語扱い寄り
    if (enRatio < 0.2) return 'ja';
    if (enRatio > 0.8) return 'en';
    return 'mixed';
  }

  return 'other';
}

// ---------- Quick Reply ヘルパー ----------
function baseQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '🏠 ホーム', text: 'ホーム' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    },
  ];
}

function toneQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: 'カジュアルに', text: 'トーン:カジュアル' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '丁寧に', text: 'トーン:丁寧' },
    },
    {
      type: 'action',
      action: { type: 'message', label: 'ビジネスに', text: 'トーン:ビジネス' },
    },
    {
      type: 'action',
      action: { type: 'message', label: 'この英文でOK', text: 'この英文でOK' },
    },
    ...baseQuickReplyItems(),
  ];
}

function homeQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '🎯 レベル', text: '[設定] レベル' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '📌 用途', text: '[設定] 用途' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '🗣 文体', text: '[設定] 文体' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '🌍 英語の雰囲気', text: '[設定] 英語タイプ' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    },
  ];
}

// ---------- Supabase ユーザー管理 ----------
// users テーブル想定：
// id, line_user_id, level_type, level_value,
// english_style, usage_default, tone_default,
// last_source_ja, last_output_en, last_source_en, last_output_ja, last_mode,
// created_at, updated_at
// それ以外のカラム（level_raw, level_normalized, english_variant 等）は
// DB 側で DEFAULT / NOT NULL を設定しておく前提。

async function getOrCreateUser(lineUserId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('line_user_id', lineUserId)
    .limit(1);

  if (error) {
    console.error('Supabase select error:', error);
    throw error;
  }

  if (data && data.length > 0) {
    return data[0];
  }

  const now = new Date().toISOString();
  const newUser = {
    line_user_id: lineUserId,
    level_type: 'eiken',
    level_value: '2',
    english_style: 'neutral',
    usage_default: 'CHAT_FRIEND',
    tone_default: 'polite',
    created_at: now,
    updated_at: now,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('users')
    .insert(newUser)
    .select('*')
    .single();

  if (insertError) {
    console.error('Supabase insert error:', insertError);
    throw insertError;
  }

  return inserted;
}

async function updateUser(lineUserId, patch) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('users')
    .update({ ...patch, updated_at: now })
    .eq('line_user_id', lineUserId)
    .select('*')
    .single();

  if (error) {
    console.error('Supabase update error:', error);
    throw error;
  }
  return data;
}

// ---------- 表示用ラベル ----------
function usageSceneLabel(usage_default) {
  switch (usage_default) {
    case 'CHAT_FRIEND':
      return '友だち・同僚とのチャット（DM / LINEなど）';
    case 'MAIL_INTERNAL':
      return '社内メール（上司・同僚向け）';
    case 'MAIL_EXTERNAL':
      return '社外メール（お客様・取引先向け）';
    default:
      return '友だち・同僚とのチャット（DM / LINEなど）';
  }
}

function toneLabel(tone_default) {
  switch (tone_default) {
    case 'casual':
      return 'カジュアル（友だち向け）';
    case 'business':
      return 'ビジネス（社外メール向け）';
    default:
      return '丁寧（上司にもOK）';
  }
}

function englishStyleLabel(style) {
  switch (style) {
    case 'american':
      return 'アメリカ英語っぽく';
    case 'british':
      return 'イギリス英語っぽく';
    default:
      return '日本人向け（無難な世界標準）';
  }
}

function levelLabel(user) {
  if (user.level_type === 'eiken') {
    const v = (user.level_value || '').toLowerCase();
    switch (v) {
      case '5':
        return '英検5級';
      case '4':
        return '英検4級';
      case '3':
        return '英検3級';
      case 'pre2':
        return '英検準2級';
      case '2':
        return '英検2級';
      case 'pre1':
        return '英検準1級';
      case '1':
        return '英検1級';
      default:
        return `英検${user.level_value}級`;
    }
  }
  if (user.level_type === 'toeic') {
    return `TOEIC ${user.level_value}`;
  }
  return `ざっくり ${user.level_value}`;
}

function buildHomeText(user) {
  return (
    '🏠 YourTranslator ホーム\n\n' +
    'いまの設定はこんな感じです：\n' +
    `・レベル：${levelLabel(user)}\n` +
    `・よく使う場面：${usageSceneLabel(user.usage_default)}\n` +
    `・英語の雰囲気：${englishStyleLabel(user.english_style)}\n` +
    `・デフォルト文体：${toneLabel(user.tone_default)}\n\n` +
    '🔍 ざっくりいうと…\n' +
    '・レベル → どのくらいむずかしい英語まで使うか\n' +
    '・場面 → チャット用か、社内メールか、社外メールか\n' +
    '・英語の雰囲気 → アメリカ寄り / イギリス寄り / 無難\n' +
    '・文体 → カジュアル / 丁寧 / ビジネス\n\n' +
    '変えたいところがあれば、下のボタンから調整できます。'
  );
}

// ---------- OpenAI 呼び出し ----------
async function generateEnglishFromJapanese({ user, sourceText, toneOverride }) {
  const levelText =
    user.level_type === 'eiken'
      ? `EIKEN Grade ${user.level_value}`
      : user.level_type === 'toeic'
      ? `TOEIC score range ${user.level_value}`
      : `rough level ${user.level_value}`;

  const usageText = {
    CHAT_FRIEND: 'chat messages with friends or colleagues (DM, LINE, Slack, etc.)',
    MAIL_INTERNAL: 'internal business emails to colleagues or managers',
    MAIL_EXTERNAL: 'formal business emails to clients or external partners',
  }[user.usage_default] || 'chat messages with friends or colleagues';

  const tone = toneOverride || user.tone_default; // 'casual' | 'polite' | 'business'

  const systemPrompt = `
You are an English writing assistant for Japanese users.

When the user sends Japanese, you:
- Translate or rewrite it into natural English.
- Consider the user's level, usage scene, tone, and English style.
- Output ONLY the English sentence(s). No Japanese, no explanations, no quotes.

Tone rules:
- If Tone = "casual":
  - Use contractions (I'm, don't, we'll).
  - Sound friendly and relaxed.
  - Still polite enough for normal workplace chat.
- If Tone = "polite":
  - Neutral, polite English.
  - Good for emails to colleagues or managers.
- If Tone = "business":
  - More formal and structured.
  - Suitable for external clients and business situations.
  - Avoid slang and overly casual phrases.

Even for short sentences, try to make the tone difference clearly visible.
  `.trim();

  const userPrompt = `
User level: ${levelText}
Usage scene: ${usageText}
Tone: ${tone}
English style: ${user.english_style} (neutral = globally understandable)
Source language: Japanese

Japanese text:
${sourceText}
  `.trim();

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion.choices[0]?.message?.content?.trim() || '';
  return content;
}

async function explainEnglishToJapaneseWithGlossary({ user, sourceText }) {
  const levelText =
    user.level_type === 'eiken'
      ? `EIKEN Grade ${user.level_value}`
      : user.level_type === 'toeic'
      ? `TOEIC score range ${user.level_value}`
      : `rough level ${user.level_value}`;

  const systemPrompt = `
You are an English-to-Japanese translator and tutor for Japanese learners.

Your job:
1. Translate the English text into natural Japanese.
2. Then pick 0–5 words or expressions that are probably difficult for the user.
3. For each term, give:
   - "term": the original English word or phrase (do NOT translate this).
   - "meaning_ja": a short Japanese meaning (1 short phrase).
   - "note_ja": an optional, very short explanation in easy Japanese.

Important:
- "term" MUST be exactly the English word/phrase from the input.
- Do NOT put Japanese words into "term".
- Keep "meaning_ja" and "note_ja" simple and compact.

Return ONLY a JSON object like this:

{
  "ja": "自然な日本語訳",
  "glossary": [
    { "term": "英単語や表現", "meaning_ja": "日本語の意味（短く）", "note_ja": "やさしい補足（あれば）" }
  ]
}

No extra text. No comments. No Markdown. No backticks.
  `.trim();

  const userPrompt = `
User level: ${levelText}

English text:
${sourceText}
  `.trim();

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  let raw = completion.choices[0]?.message?.content || '';

  raw = raw.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('JSON parse error from OpenAI:', e, raw);
    return {
      ja: raw,
      glossary: [],
    };
  }

  return {
    ja: parsed.ja || '',
    glossary: Array.isArray(parsed.glossary) ? parsed.glossary : [],
  };
}

// ---------- 各種返信 ----------
async function replyHelp(replyToken) {
  const message = {
    type: 'text',
    text:
      'YourTranslator です 👋\n\n' +
      '📌 できること\n' +
      '・日本語で送る → あなた向けの英語文を作成\n' +
      '・英語で送る → 和訳＋むずかしそうな単語をサクッと解説\n' +
      '・日本語＋英語まじり → 「英訳 / 和訳」を選んで処理\n\n' +
      'まずは「ホーム」でレベルや場面をゆるっと決めておくとラクです。\n' +
      '細かいルールは気にしなくてOKなので、「送りたい文」をそのまま投げてください。',
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyHome(replyToken, user) {
  const message = {
    type: 'text',
    text: buildHomeText(user),
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyUsage(replyToken) {
  const text =
    '❓ YourTranslator の使い方（ざっくり）\n\n' +
    '1️⃣ まずは「ホーム」で設定\n' +
    '・レベル：英検◯級くらいを選ぶ\n' +
    '・用途：チャット / 社内メール / 社外メール\n' +
    '・文体：カジュアル / 丁寧 / ビジネス\n' +
    '・英語の雰囲気：無難 / アメリカっぽく / イギリスっぽく\n\n' +
    '2️⃣ その後は、文を送るだけ\n' +
    '・日本語 → 英文を作成\n' +
    '・英語 → 和訳＋むずかしそうな単語をコンパクトに解説\n\n' +
    '3️⃣ 英文が出たあと\n' +
    '・クイックメニューで「カジュアル / 丁寧 / ビジネス」に言い換え\n' +
    '・「この英文でOK」を押すと、本文だけ＋ワンポイントレッスン\n\n' +
    'あとは、実際に仕事やDMで使いながら微調整していく感じのツールです。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: baseQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// ---------- レベル設定 ----------
async function replyLevelRoot(replyToken) {
  const message = {
    type: 'text',
    text: '🎯 レベルの決め方を選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '英検で設定', text: '[設定] 英検レベル' },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'TOEIC（準備中）',
            text: 'TOEIC設定は準備中です',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'ざっくり（準備中）',
            text: 'ざっくりレベル設定は準備中です',
          },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyLevelEiken(replyToken) {
  const message = {
    type: 'text',
    text: '英検の級を選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '5級', text: 'SET_LEVEL_EIKEN_5' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '4級', text: 'SET_LEVEL_EIKEN_4' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '3級', text: 'SET_LEVEL_EIKEN_3' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '準2級', text: 'SET_LEVEL_EIKEN_PRE2' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '2級', text: 'SET_LEVEL_EIKEN_2' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '準1級', text: 'SET_LEVEL_EIKEN_PRE1' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '1級', text: 'SET_LEVEL_EIKEN_1' },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetLevelEiken(replyToken, user, text) {
  const code = text.replace('SET_LEVEL_EIKEN_', ''); // 5,4,3,PRE2,2,PRE1,1
  const value = code.toLowerCase();

  const updated = await updateUser(user.line_user_id, {
    level_type: 'eiken',
    level_value: value,
  });

  const header = `🎯 レベルを「${levelLabel(updated)}」のイメージで登録しました。\n\n`;
  const message = {
    type: 'text',
    text: header + buildHomeText(updated),
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- 用途設定 ----------
async function replyUsageScene(replyToken) {
  const message = {
    type: 'text',
    text: '📌 よく使う場面を選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '友だち・同僚チャット',
            text: 'SET_USAGE_CHAT_FRIEND',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '社内メール',
            text: 'SET_USAGE_MAIL_INTERNAL',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '社外メール',
            text: 'SET_USAGE_MAIL_EXTERNAL',
          },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetUsageScene(replyToken, user, text) {
  let usage = 'CHAT_FRIEND';
  if (text === 'SET_USAGE_MAIL_INTERNAL') usage = 'MAIL_INTERNAL';
  if (text === 'SET_USAGE_MAIL_EXTERNAL') usage = 'MAIL_EXTERNAL';

  const updated = await updateUser(user.line_user_id, {
    usage_default: usage,
  });

  const header = `📌 場面を「${usageSceneLabel(updated.usage_default)}」として登録しました。\n\n`;
  const message = {
    type: 'text',
    text: header + buildHomeText(updated),
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- 文体設定 ----------
async function replyToneSetting(replyToken) {
  const message = {
    type: 'text',
    text:
      '🗣 ふだんの文体を選んでください。\n\n' +
      '・カジュアル：友だち / 気心知れた同僚向け\n' +
      '・丁寧：上司にもそのまま送れるくらい\n' +
      '・ビジネス：社外メールやかしこまった場面向け',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: 'カジュアル', text: 'SET_TONE_CASUAL' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '丁寧', text: 'SET_TONE_POLITE' },
        },
        {
          type: 'action',
          action: { type: 'message', label: 'ビジネス', text: 'SET_TONE_BUSINESS' },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetTone(replyToken, user, text) {
  let tone = 'polite';
  if (text === 'SET_TONE_CASUAL') tone = 'casual';
  if (text === 'SET_TONE_BUSINESS') tone = 'business';

  const updated = await updateUser(user.line_user_id, {
    tone_default: tone,
  });

  const header = `🗣 デフォルト文体を「${toneLabel(updated.tone_default)}」にしました。\n\n`;
  const message = {
    type: 'text',
    text: header + buildHomeText(updated),
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- 英語タイプ設定 ----------
async function replyEnglishStyle(replyToken) {
  const message = {
    type: 'text',
    text:
      '🌍 英語の雰囲気を選んでください。\n\n' +
      '・日本人向け（無難）：まずはこれでOK\n' +
      '・アメリカ英語っぽく：USの同僚やお客さんが多いとき\n' +
      '・イギリス英語っぽく：UK寄りの表現が好みのとき',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '日本人向け（無難）',
            text: 'SET_EN_STYLE_NEUTRAL',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'アメリカ英語っぽく',
            text: 'SET_EN_STYLE_AMERICAN',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'イギリス英語っぽく',
            text: 'SET_EN_STYLE_BRITISH',
          },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetEnglishStyle(replyToken, user, text) {
  let style = 'neutral';
  if (text === 'SET_EN_STYLE_AMERICAN') style = 'american';
  if (text === 'SET_EN_STYLE_BRITISH') style = 'british';

  const updated = await updateUser(user.line_user_id, {
    english_style: style,
  });

  const header = `🌍 英語の雰囲気を「${englishStyleLabel(updated.english_style)}」にしました。\n\n`;
  const message = {
    type: 'text',
    text: header + buildHomeText(updated),
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- トーン変更（クイックリプライ） ----------
async function handleToneChange(replyToken, user, toneLabelJa) {
  if (!user.last_source_ja) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って英文を作ってから、文体を変えてみてください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }

  let toneOverride = user.tone_default;
  if (toneLabelJa.includes('カジュアル')) toneOverride = 'casual';
  if (toneLabelJa.includes('丁寧')) toneOverride = 'polite';
  if (toneLabelJa.includes('ビジネス')) toneOverride = 'business';

  const en = await generateEnglishFromJapanese({
    user,
    sourceText: user.last_source_ja,
    toneOverride,
  });

  await updateUser(user.line_user_id, {
    last_output_en: en,
    last_mode: 'JA_TO_EN',
  });

  const message = {
    type: 'text',
    text: en,
    quickReply: { items: toneQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- 「この英文でOK」 ----------
async function handleAcceptCurrentEnglish(replyToken, user) {
  const en = user.last_output_en;
  if (!en) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って、英文を作ってから選んでください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }

  const usageText = {
    CHAT_FRIEND: 'casual chat with friends or colleagues (chat apps, DMs, etc.)',
    MAIL_INTERNAL: 'polite internal business emails to colleagues or managers',
    MAIL_EXTERNAL: 'formal external business emails to clients or partners',
  }[user.usage_default] || 'casual chat with friends or colleagues (chat apps, DMs, etc.)';

  const copyMessage = {
    type: 'text',
    text: en,
  };

  const systemPrompt = `
You are an English coach for Japanese learners.
The user has just decided to use the following English sentence in this context:
- Usage: ${usageText}

Your task:
1. Suggest ONE upgraded version of the sentence.
2. Keep the SAME level of formality that matches the usage.
3. Do NOT make the sentence more casual than necessary.
4. Do NOT radically change the tone (casual -> very formal, or formal -> very casual).

Output format (in Japanese, except for the upgraded English sentence):

アップグレード例:
"<Upgraded English sentence>"

解説:
・どこをどう良くしたか（日本語で1〜2文）
・ニュアンスの違い（あれば一言で）

Rules:
- 3〜5行。
- 日本語はフレンドリーだが、なれなれしくしない。
- 元の英文と全く同じ言い回しにならないようにする。
  `.trim();

  const userPrompt = `English sentence:\n${en}`;

  let lessonText = '';
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    lessonText = completion.choices[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('One-point lesson error:', e);
  }

  const lessonMessage = lessonText
    ? {
        type: 'text',
        text: 'ワンポイントレッスン\n------------------------------\n' + lessonText,
        quickReply: { items: baseQuickReplyItems() },
      }
    : {
        type: 'text',
        text: 'コピペ用の英文をお届けしました。',
        quickReply: { items: baseQuickReplyItems() },
      };

  return lineClient.replyMessage(replyToken, [copyMessage, lessonMessage]);
}

// ---------- 日本語 → 英語 ----------
async function handleJaToEn(text, replyToken, user, options = {}) {
  const en = await generateEnglishFromJapanese({
    user,
    sourceText: text,
    toneOverride: null,
  });

  await updateUser(user.line_user_id, {
    last_source_ja: text,
    last_output_en: en,
    last_mode: 'JA_TO_EN',
  });

  const message = {
    type: 'text',
    text: en,
    quickReply: { items: toneQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// ---------- 英語 → 日本語（和訳＋語彙解説） ----------
async function handleEnToJa(text, replyToken, user, options = {}) {
  const { ja, glossary } = await explainEnglishToJapaneseWithGlossary({
    user,
    sourceText: text,
  });

  let resultText = ja;
  if (glossary && glossary.length > 0) {
    resultText += '\n\n📚 むずかしいかも単語\n';
    glossary.forEach((g) => {
      if (!g.term) return;
      const meaning = g.meaning_ja || '';
      const note = g.note_ja ? `（${g.note_ja}）` : '';
      resultText += `・${g.term}：${meaning}${note}\n`;
    });
  }

  await updateUser(user.line_user_id, {
    last_source_en: text,
    last_output_ja: ja,
    last_mode: 'EN_TO_JA',
  });

  const message = {
    type: 'text',
    text: resultText,
    quickReply: { items: baseQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// ---------- 日本語＋英語混在 ----------
async function handleMixed(text, replyToken) {
  const message = {
    type: 'text',
    text:
      '日本語と英語がいっしょに入っているみたいです。\n' +
      'この文を「英訳」か「和訳」か、どちらで扱うか選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '英訳してほしい',
            text: `TRANSLATE_TO_EN:::${text}`,
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '和訳してほしい',
            text: `TRANSLATE_TO_JA:::${text}`,
          },
        },
        ...baseQuickReplyItems(),
      ],
    },
  };

  return lineClient.replyMessage(replyToken, message);
}

// ---------- メインイベントハンドラ ----------
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userId = event.source.userId;
  if (!userId) return;

  const text = (event.message.text || '').trim();
  const user = await getOrCreateUser(userId);

  // 特殊コマンド（混在テキストからの分岐用）
  if (text.startsWith('TRANSLATE_TO_EN:::')) {
    const original = text.replace('TRANSLATE_TO_EN:::', '');
    return handleJaToEn(original, event.replyToken, user, { force: 'en' });
  }
  if (text.startsWith('TRANSLATE_TO_JA:::')) {
    const original = text.replace('TRANSLATE_TO_JA:::', '');
    return handleEnToJa(original, event.replyToken, user, { force: 'ja' });
  }

  // 設定・ヘルプ系
  if (text === 'ヘルプ') {
    return replyHelp(event.replyToken);
  }
  if (text === 'ホーム') {
    return replyHome(event.replyToken, user);
  }
  if (text === '使い方') {
    return replyUsage(event.replyToken);
  }

  // 設定フロー
  if (text === '[設定] レベル') {
    return replyLevelRoot(event.replyToken);
  }
  if (text === '[設定] 英検レベル') {
    return replyLevelEiken(event.replyToken);
  }
  if (text.startsWith('SET_LEVEL_EIKEN_')) {
    return handleSetLevelEiken(event.replyToken, user, text);
  }

  if (text === '[設定] 用途') {
    return replyUsageScene(event.replyToken);
  }
  if (text.startsWith('SET_USAGE_')) {
    return handleSetUsageScene(event.replyToken, user, text);
  }

  if (text === '[設定] 文体') {
    return replyToneSetting(event.replyToken);
  }
  if (text.startsWith('SET_TONE_')) {
    return handleSetTone(event.replyToken, user, text);
  }

  if (text === '[設定] 英語タイプ') {
    return replyEnglishStyle(event.replyToken);
  }
  if (text.startsWith('SET_EN_STYLE_')) {
    return handleSetEnglishStyle(event.replyToken, user, text);
  }

  // トーン変更
  if (text.startsWith('トーン:')) {
    const toneLabel = text.replace('トーン:', '');
    return handleToneChange(event.replyToken, user, toneLabel);
  }

  // 「この英文でOK」
  if (text.includes('この英文で')) {
    return handleAcceptCurrentEnglish(event.replyToken, user);
  }

  // 本文処理
  const lang = detectLanguage(text);

  if (lang === 'ja') {
    return handleJaToEn(text, event.replyToken, user);
  } else if (lang === 'en') {
    return handleEnToJa(text, event.replyToken, user);
  } else if (lang === 'mixed') {
    return handleMixed(text, event.replyToken);
  } else {
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '今は日本語と英語だけをサポートしています。\n日本語か英語で送ってみてください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }
}

// ---------- Webhook エンドポイント ----------
app.post('/webhook', middleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  if (!events || events.length === 0) {
    return res.status(200).end();
  }

  try {
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Error handling events:', err);
    res.status(500).end();
  }
});

// ---------- サーバー起動 ----------
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
