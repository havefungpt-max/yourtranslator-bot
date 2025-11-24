// index.js
// YourTranslator / LINE Bot
// 必要な環境変数：
// - LINE_CHANNEL_ACCESS_TOKEN
// - LINE_CHANNEL_SECRET
// - OPENAI_API_KEY
// - OPENAI_MODEL (任意。指定なければ gpt-4o-mini)
// - SUPABASE_URL
// - SUPABASE_SERVICE_ROLE_KEY
// - PREMIUM_USER_IDS (任意。カンマ区切りの LINE userId リスト。例: "Uxxxx,Uyyyy")

const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
require('dotenv').config();

// ---------- 利用制限の設定 ----------

const FREE_MAX_CHARS = 1000;
const FREE_MAX_REQUESTS_PER_DAY = 5;
const PREMIUM_MAX_CHARS = 3000;

const premiumIds = (process.env.PREMIUM_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const usageCounters = {}; // { [line_user_id]: { date: 'YYYY-MM-DD', count: number } }

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function isPremiumUser(user) {
  if (!user || !user.line_user_id) return false;
  if (premiumIds.includes(user.line_user_id)) return true;
  // 将来的に users.plan === 'premium' などを追加するならここで見る
  return false;
}

function checkAndConsumeQuota(user, text) {
  const len = (text || '').length;
  const premium = isPremiumUser(user);
  const maxChars = premium ? PREMIUM_MAX_CHARS : FREE_MAX_CHARS;
  const maxRequests = premium ? Infinity : FREE_MAX_REQUESTS_PER_DAY;

  if (len > maxChars) {
    return {
      ok: false,
      reason: 'too_long',
      premium,
      maxChars,
      length: len,
    };
  }

  if (!premium) {
    const id = user.line_user_id;
    const today = todayString();
    let info = usageCounters[id] || { date: today, count: 0 };

    if (info.date !== today) {
      info = { date: today, count: 0 };
    }

    if (info.count >= maxRequests) {
      usageCounters[id] = info;
      return {
        ok: false,
        reason: 'quota_exceeded',
        premium,
        maxRequests,
        used: info.count,
      };
    }

    info.count += 1;
    usageCounters[id] = info;
  }

  return { ok: true };
}

// ---------- 基本セットアップ ----------

const app = express();

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

// LINE Webhook
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

// ---------- ユーザー情報（Supabase） ----------

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

  // デフォルト値（スキーマは前回のものを想定）
  const now = new Date().toISOString();
  const newUser = {
    line_user_id: lineUserId,
    level_type: 'eiken',          // 'eiken' | 'toeic' | 'rough'
    level_value: '2',             // '5','4','3','pre2','2','pre1','1' など
    english_style: 'japanese',    // 'japanese' | 'american' | 'british'
    usage_default: 'CHAT_FRIEND', // 'CHAT_FRIEND' | 'MAIL_INTERNAL' | 'MAIL_EXTERNAL'
    tone_default: 'polite',       // 'casual' | 'polite' | 'business'
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

// ---------- ヘルパー：言語判定 ----------
// 大文字だけの "AI", "DB" などは英語とみなさない。
// 小文字の英字が含まれている場合だけ英語扱いにする。

function detectLanguage(text) {
  const hasJa = /[一-龯ぁ-んァ-ン]/.test(text);
  const hasRealEn = /[a-z]/.test(text); // 小文字を含む英字

  if (hasJa && hasRealEn) return 'mixed';
  if (hasJa) return 'ja';
  if (hasRealEn) return 'en';
  return 'other';
}

// ---------- ヘルパー：Quick Reply ----------

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
      action: { type: 'message', label: '🏢 用途', text: '[設定] 用途' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '✉️ 文体', text: '[設定] 文体' },
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

function premiumQuickReplyItems() {
  const base = baseQuickReplyItems();
  return [
    {
      type: 'action',
      action: {
        type: 'message',
        label: '🌟 もっと詳しく知りたい',
        text: '[プレミアム] 詳しい解説',
      },
    },
    ...base,
  ];
}

// ---------- ラベル系 ----------

function usageSceneLabel(usage_default) {
  switch (usage_default) {
    case 'CHAT_FRIEND':
      return '友だち・同僚とのチャット';
    case 'MAIL_INTERNAL':
      return '社内メール';
    case 'MAIL_EXTERNAL':
      return '社外メール（お客様・取引先向け）';
    default:
      return '友だち・同僚とのチャット';
  }
}

function toneLabel(tone_default) {
  switch (tone_default) {
    case 'casual':
      return 'カジュアル（友だち向け）';
    case 'business':
      return 'ビジネス（かっちりめ）';
    default:
      return '丁寧（敬語ベース）';
  }
}

function englishStyleLabel(style) {
  switch (style) {
    case 'american':
      return 'アメリカ英語';
    case 'british':
      return 'イギリス英語';
    case 'japanese':
    default:
      return '日本人英語';
  }
}

function levelLabel(user) {
  if (user.level_type === 'eiken') {
    switch (user.level_value) {
      case 'pre1':
        return '英検準1級';
      case 'pre2':
        return '英検準2級';
      default:
        return `英検${user.level_value}級`;
    }
  }
  if (user.level_type === 'toeic') {
    return `TOEIC ${user.level_value}`;
  }
  return `ざっくり ${user.level_value}`;
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
    CHAT_FRIEND: 'chat with friends or colleagues',
    MAIL_INTERNAL: 'internal business email',
    MAIL_EXTERNAL: 'external business email with clients',
  }[user.usage_default] || 'chat with friends or colleagues';

  const tone = toneOverride || user.tone_default; // 'casual' | 'polite' | 'business'

  const styleText = {
    japanese:
      'Japanese-leaning English (what many Japanese learners naturally write)',
    american: 'American English',
    british: 'British English',
  }[user.english_style] ||
    'Japanese-leaning English (what many Japanese learners naturally write)';

  const systemPrompt = `
You are an English writing assistant for Japanese users.
- When the user sends Japanese, translate or rewrite it into natural English.
- Consider the user's level, usage scene, tone, and English style.
- Output ONLY the English sentence(s). No Japanese. No explanations. No quotes.
  `.trim();

  const userPrompt = `
User level: ${levelText}
Usage scene: ${usageText}
Tone: ${tone}
English style: ${styleText}
Source language: Japanese

Japanese text:
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
- First, translate the English text into natural Japanese.
- Then, pick up 0–5 words or expressions that are probably difficult for the user.
- The user level will be provided.
- Return ONLY a JSON object with this shape:

{
  "ja": "自然な日本語訳",
  "glossary": [
    { "term": "英単語や表現", "meaning_ja": "日本語の意味", "note_ja": "やさしい日本語での補足" }
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

async function generateOnePointLesson(enSentence) {
  const systemPrompt = `
You are an English coach for Japanese learners.
The user has decided to use the following English sentence in a real message.
Your job is to give a short, friendly follow-up in Japanese.

Rules:
- Start with the line: "✏️ ちょこっと英語メモ"
- If there is a clearly more natural or native-like version, show it like:
  "ネイティブなら例えば: <example sentence>"
- If the original sentence is already natural enough, say:
  "この文はこのままで十分自然です。"
- After that, add 1–2 short bullet points in Japanese explaining a nuance, word choice, or tone.
- Optionally, add one short "trivia" bullet about origin, typical usage, or a related expression.
- Do NOT criticise the user. Talk about the sentence itself, not "you".
- Keep it within about 4–6 short lines total.
- Output only Japanese, except the example English sentence within that line.
  `.trim();

  const userPrompt = `英語の文:\n${enSentence}`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || '';
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

  // 特殊コマンド（ミックス入力用）
  if (text.startsWith('TRANSLATE_TO_EN:::')) {
    const original = text.replace('TRANSLATE_TO_EN:::', '');
    return handleJaToEn(original, event.replyToken, user);
  }
  if (text.startsWith('TRANSLATE_TO_JA:::')) {
    const original = text.replace('TRANSLATE_TO_JA:::', '');
    return handleEnToJa(original, event.replyToken, user);
  }

  // プレミアム説明プレースホルダ
  if (text === '[プレミアム] 詳しい解説') {
    return replyPremiumInfo(event.replyToken);
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
    const toneLabelJa = text.replace('トーン:', '');
    return handleToneChange(event.replyToken, user, toneLabelJa);
  }

  // 「この英文でOK」 → ちょこっと英語メモ
  if (text.includes('この英文で')) {
    return handleAcceptCurrentEnglish(event.replyToken, user);
  }

  // ここから本文処理
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
      text:
        '今は日本語と英語だけをサポートしています。\n' +
        '日本語か英語で送ってみてください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }
}

// ---------- 各種返信ハンドラ ----------

async function replyHelp(replyToken) {
  const message = {
    type: 'text',
    text:
      'YourTranslator は、キレイすぎる翻訳ツールや AI の英語ではなく、\n' +
      'あなたが普段使いそうな自然な英文と、ネイティブならこう言いそうな一段上の英文を提案する相棒です。\n' +
      '英文を貼ってもらえれば、和訳とちょっとした解説も返します。\n\n' +
      '・日本語で送る → 英文を作成\n' +
      '・英語で送る → 和訳＋むずかしめ単語のミニ解説\n' +
      '・日本語＋英語まじり → 英訳 / 和訳を選択\n\n' +
      'まずは「ホーム」でレベルやよく使う場面をゆるく決めておくとラクです。',
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyPremiumInfo(replyToken) {
  const message = {
    type: 'text',
    text:
      'プレミアム版のイメージ（まだ仮）です：\n\n' +
      '・1回あたりの文字数上限アップ（1000文字 → 3000文字）\n' +
      '・1日の回数制限なし（無料版は1日5回まで）\n' +
      '・英語メモの解説を、もう少し深掘り\n\n' +
      '※ 課金の方法や料金は、別途ご案内予定です。',
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyHome(replyToken, user) {
  const text =
    '🏠 YourTranslator ホーム\n\n' +
    'いまの設定はこんな感じです：\n\n' +
    `・${levelLabel(user)}\n` +
    `・よく使う場面：${usageSceneLabel(user.usage_default)}\n` +
    `・英語の雰囲気：${englishStyleLabel(user.english_style)}\n` +
    `・文体：${toneLabel(user.tone_default)}\n\n` +
    '🔍 この4つで何が変わる？\n' +
    '・レベル → あなたが書きそうな英文の「単語・文法レベル」の目安\n' +
    '・場面 → チャット用か、社内メールか、社外メールか\n' +
    '・英語の雰囲気 → 日本人英語 / アメリカ英語 / イギリス英語\n' +
    '・文体 → カジュアル / 丁寧 / ビジネス\n\n' +
    '変えたいところがあれば、下のボタンから調整できます。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyUsage(replyToken) {
  const text =
    'YourTranslator は、あなたのレベルに合わせて\n' +
    '「自分でも書けそうな英文」と「ネイティブならこう言うかも」という英文を提案する英語ヘルパーです。\n\n' +
    '📝 使い方（ざっくり）\n' +
    '1. 「ホーム」でレベル・場面・文体・英語の雰囲気を決める\n' +
    '2. 日本語 or 英語の文を送る\n' +
    '   ・日本語 → 英文を提案\n' +
    '   ・英語 → 和訳＋むずかしい単語・表現のミニ解説\n' +
    '3. 英文が出たら、クイックメニューで\n' +
    '   ・カジュアル / 丁寧 / ビジネス に言い換え\n' +
    '   ・「この英文でOK」で、ちょこっと英語メモが届く\n\n' +
    '無料版は 1回あたり最大1000文字・1日5回までです。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: baseQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// --- レベル設定 ---

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
  let value = code.toLowerCase(); // pre2, pre1 など

  const updated = await updateUser(user.line_user_id, {
    level_type: 'eiken',
    level_value: value,
  });

  const message = {
    type: 'text',
    text:
      `🎯 レベルを「${levelLabel(updated)}」のイメージで登録しました。\n\n` +
      '日本語か英語で文を送ってみてください。',
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// --- 用途設定 ---

async function replyUsageScene(replyToken) {
  const message = {
    type: 'text',
    text: 'よく使う場面を選んでください。',
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

  const message = {
    type: 'text',
    text: `よく使う場面を「${usageSceneLabel(
      updated.usage_default
    )}」として登録しました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// --- 文体設定 ---

async function replyToneSetting(replyToken) {
  const message = {
    type: 'text',
    text: 'ふだんの文体を選んでください。',
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

  const message = {
    type: 'text',
    text: `文体を「${toneLabel(updated.tone_default)}」にしました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// --- 英語タイプ設定 ---

async function replyEnglishStyle(replyToken) {
  const message = {
    type: 'text',
    text:
      '🌍 英語の雰囲気を選んでください。\n\n' +
      '・日本人英語：日本人が学校で習ってきた英語ベース\n' +
      '・アメリカ英語：US 寄りの言い回し\n' +
      '・イギリス英語：UK 寄りの言い回し',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '日本人英語',
            text: 'SET_EN_STYLE_JAPANESE',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'アメリカ英語',
            text: 'SET_EN_STYLE_AMERICAN',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'イギリス英語',
            text: 'SET_EN_STYLE_BRITISH',
          },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetEnglishStyle(replyToken, user, text) {
  let style = 'japanese';
  if (text === 'SET_EN_STYLE_AMERICAN') style = 'american';
  if (text === 'SET_EN_STYLE_BRITISH') style = 'british';

  const updated = await updateUser(user.line_user_id, {
    english_style: style,
  });

  const message = {
    type: 'text',
    text: `英語の雰囲気を「${englishStyleLabel(updated.english_style)}」にしました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// --- トーン変更 ---

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

  const quota = checkAndConsumeQuota(user, user.last_source_ja);
  if (!quota.ok) {
    return replyQuotaError(replyToken, quota);
  }

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

// --- 「この英文でOK」 ---

async function handleAcceptCurrentEnglish(replyToken, user) {
  const en = user.last_output_en;
  if (!en) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って、英文を作ってから選んでください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }

  let lessonText = '';
  try {
    lessonText = await generateOnePointLesson(en);
  } catch (e) {
    console.error('One-point lesson error:', e);
  }

  const message = {
    type: 'text',
    text:
      lessonText ||
      '✏️ ちょこっと英語メモ\nこの文はこのままでも十分自然です。',
    quickReply: { items: premiumQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// --- 利用上限エラーメッセージ ---

async function replyQuotaError(replyToken, quota) {
  if (quota.reason === 'too_long') {
    const msg =
      `いまは1回あたり最大 ${quota.maxChars}文字まで対応しています。\n` +
      `今回のメッセージはだいたい ${quota.length}文字くらいありそうです。\n\n` +
      '文章を少し分割して送ってみてください。\n' +
      'プレミアム版では上限を拡大する予定です。';

    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: msg,
      quickReply: { items: premiumQuickReplyItems() },
    });
  }

  if (quota.reason === 'quota_exceeded') {
    const msg =
      `今日の無料利用（${quota.maxRequests}回）は使い切りました。\n\n` +
      'また明日お試しいただくか、プレミアム版での拡張も検討中です。';

    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: msg,
      quickReply: { items: premiumQuickReplyItems() },
    });
  }
}

// --- 日本語 → 英語 ---

async function handleJaToEn(text, replyToken, user) {
  const quota = checkAndConsumeQuota(user, text);
  if (!quota.ok) {
    return replyQuotaError(replyToken, quota);
  }

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

// --- 英語 → 日本語（和訳＋語彙解説） ---

async function handleEnToJa(text, replyToken, user) {
  const quota = checkAndConsumeQuota(user, text);
  if (!quota.ok) {
    return replyQuotaError(replyToken, quota);
  }

  const { ja, glossary } = await explainEnglishToJapaneseWithGlossary({
    user,
    sourceText: text,
  });

  let resultText = ja;
  if (glossary && glossary.length > 0) {
    resultText += '\n\n📚 むずかしいかも単語\n';
    glossary.forEach((g) => {
      if (!g.term) return;
      resultText += `・${g.term}\n  意味: ${g.meaning_ja || ''}\n`;
      if (g.note_ja) {
        resultText += `  メモ: ${g.note_ja}\n`;
      }
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

// --- 日本語＋英語混在 ---

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

// ---------- サーバー起動 ----------

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
