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

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'; // コスト低め

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

  // デフォルト値（DB の NOT NULL / DEFAULT は既に緩めた前提）
  const now = new Date().toISOString();
  const newUser = {
    line_user_id: lineUserId,
    level_type: 'eiken',          // 'eiken' | 'toeic' | 'rough'
    level_value: '2',             // 例: '5','4','3','pre2','2','pre1','1' or '1','2','3','4' for rough
    english_style: 'neutral',     // 'neutral' | 'american' | 'british'
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

function detectLanguage(text) {
  const hasJa = /[一-龯ぁ-んァ-ン]/.test(text);
  const hasEn = /[A-Za-z]/.test(text);

  if (hasJa && hasEn) return 'mixed';
  if (hasJa) return 'ja';
  if (hasEn) return 'en';
  return 'other';
}

// ---------- ヘルパー：Quick Reply ----------

// どの画面でも基本的に出したいナビ
function baseQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '🏠 ホーム', text: 'ホーム' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '⚙️ 設定', text: '設定' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    },
  ];
}

// 英文が出た後に出すトーン関連のメニュー
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

// ホーム画面専用（ユーザー要望：設定 & 使い方 のみ）
function homeQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '⚙️ 設定', text: '設定' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    },
  ];
}

// 設定画面用
function settingsQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: 'レベル', text: '[設定] レベル' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '用途', text: '[設定] 用途' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '文体', text: '[設定] 文体' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '🧩 かんたん設定', text: '[設定] かんたん設定' },
    },
    ...baseQuickReplyItems(),
  ];
}

// ---------- ラベル系ヘルパー ----------

function usageSceneLabel(usage_default) {
  switch (usage_default) {
    case 'CHAT_FRIEND':
      return '友だち・同僚とのチャット';
    case 'MAIL_INTERNAL':
      return '社内メール';
    case 'MAIL_EXTERNAL':
      return '社外メール';
    default:
      return '友だち・同僚とのチャット';
  }
}

function toneLabel(tone_default) {
  switch (tone_default) {
    case 'casual':
      return 'カジュアル';
    case 'business':
      return 'ビジネス';
    default:
      return '丁寧';
  }
}

function englishStyleLabel(style) {
  switch (style) {
    case 'american':
      return 'アメリカ寄り';
    case 'british':
      return 'イギリス寄り';
    default:
      return '日本人向け（無難）';
  }
}

function levelLabel(user) {
  if (user.level_type === 'eiken') {
    // e.g. '3', 'pre2', '2', 'pre1'
    const v = String(user.level_value || '').toLowerCase();
    if (v === 'pre2') return '準2級';
    if (v === 'pre1') return '準1級';
    return `${v}級`;
  }
  if (user.level_type === 'toeic') {
    return `TOEIC ${user.level_value}`;
  }
  // rough
  return `ざっくりレベル${user.level_value}`;
}

// サンプル日本語（設定画面・レベルイメージ・かんたん設定で共通）
const SAMPLE_JA = '明日のミーティングをリスケしたいです。';

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
English style: ${user.english_style} (neutral = globally understandable)
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
- term MUST be the original English word or phrase (not Japanese).
- meaning_ja and note_ja should be short and easy to understand.
- Return ONLY a JSON object with this shape:

{
  "ja": "自然な日本語訳",
  "glossary": [
    { "term": "英単語や英語表現", "meaning_ja": "日本語の意味（短く）", "note_ja": "あっても短く" }
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

  // 念のため、```json などを剥がす
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

// かんたん設定用：4パターンの英文候補を返す
async function generateEasySetupCandidates() {
  const systemPrompt = `
You are an English writing assistant.
Create 4 different English versions of the same Japanese sentence, as JSON.

Rules:
- candidates[0]: casual chat between friends/close colleagues
- candidates[1]: polite but friendly (e.g., chat or simple internal message)
- candidates[2]: polite internal business email style
- candidates[3]: polite external business email style
- Return ONLY this JSON:

{
  "candidates": [
    "English version 1",
    "English version 2",
    "English version 3",
    "English version 4"
  ]
}

No extra text. No comments. No Markdown.
  `.trim();

  const userPrompt = `
Japanese text:
${SAMPLE_JA}
  `.trim();

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
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

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.candidates) && parsed.candidates.length === 4) {
      return parsed.candidates.map((s) => String(s || '').trim());
    }
  } catch (e) {
    console.error('JSON parse error (easy setup):', e, raw);
  }

  // フォールバック：手書きの4パターン
  return [
    "I want to reschedule tomorrow's meeting.",
    "Could we reschedule tomorrow's meeting?",
    "I'd like to reschedule tomorrow's meeting.",
    "I would like to reschedule tomorrow's meeting, if possible.",
  ];
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
  if (text === '設定') {
    return replySettings(event.replyToken, user);
  }

  // 設定フロー：レベル
  if (text === '[設定] レベル') {
    return replyLevelRoot(event.replyToken);
  }
  if (text === '[設定] 英検レベル') {
    return replyLevelEiken(event.replyToken);
  }
  if (text.startsWith('SET_LEVEL_EIKEN_')) {
    return handleSetLevelEiken(event.replyToken, user, text);
  }

  // 設定フロー：用途
  if (text === '[設定] 用途') {
    return replyUsageScene(event.replyToken);
  }
  if (text.startsWith('SET_USAGE_')) {
    return handleSetUsageScene(event.replyToken, user, text);
  }

  // 設定フロー：文体
  if (text === '[設定] 文体') {
    return replyToneSetting(event.replyToken);
  }
  if (text.startsWith('SET_TONE_')) {
    return handleSetTone(event.replyToken, user, text);
  }

  // 設定フロー：英語タイプ
  if (text === '[設定] 英語タイプ') {
    return replyEnglishStyle(event.replyToken);
  }
  if (text.startsWith('SET_EN_STYLE_')) {
    return handleSetEnglishStyle(event.replyToken, user, text);
  }

  // 設定フロー：かんたん設定
  if (text === '[設定] かんたん設定') {
    return replyEasySetup(event.replyToken);
  }
  if (text.startsWith('SET_EASY_PROFILE_')) {
    return handleEasyProfileSelect(event.replyToken, user, text);
  }

  // トーン変更
  if (text.startsWith('トーン:')) {
    const toneLabelJa = text.replace('トーン:', '');
    return handleToneChange(event.replyToken, user, toneLabelJa);
  }

  // 「この英文でOK」 → コピペ用＋ワンポイント
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
    // その他の言語は対象外
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '今は日本語と英語だけをサポートしています。\n日本語か英語で送ってみてください 😊',
      quickReply: { items: baseQuickReplyItems() },
    });
  }
}

// ---------- 各種返信ハンドラ ----------

async function replyHelp(replyToken) {
  const message = {
    type: 'text',
    text:
      'YourTranslator です 👋\n\n' +
      '・日本語で送る → 英文を作成\n' +
      '・英語で送る → 和訳＋むずかしめ単語のミニ解説\n' +
      '・日本語＋英語まじり → 英訳 / 和訳を選択\n\n' +
      '迷ったら「ホーム」から設定を見直せます。\n' +
      '困ったらまた「ヘルプ」と送ってください。',
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyHome(replyToken, user) {
  const text =
    'YourTranslator ホーム 🏠\n\n' +
    'いまの設定はこんな感じです：\n' +
    `・レベル: ${levelLabel(user)}\n` +
    `・よく使う場面: ${usageSceneLabel(user.usage_default)}\n` +
    `・英語の雰囲気: ${englishStyleLabel(user.english_style)}\n` +
    `・デフォルト文体: ${toneLabel(user.tone_default)}\n\n` +
    '英語の雰囲気がよく分からない場合は、\n' +
    '「⚙️ 設定」→「🧩 かんたん設定」からまとめて決めるのがおすすめです。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: homeQuickReplyItems() }, // ← ホームだけは専用
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyUsage(replyToken) {
  const text =
    'YourTranslator の使い方（ざっくり）📘\n\n' +
    '1. 「ホーム」→「設定」で、\n' +
    '   レベル・用途（チャット/社内/社外）・文体を決める\n' +
    '2. あとは日本語 or 英語の文を送るだけ\n' +
    '   ・日本語 → 英文を作成\n' +
    '   ・英語 → 和訳＋むずかしめ単語のミニ解説\n' +
    '3. 英文が出たら、クイックメニューで\n' +
    '   ・カジュアル / 丁寧 / ビジネス に言い換え\n' +
    '   ・「この英文でOK」で、本文だけ＋ワンポイントレッスン\n\n' +
    'むずかしく考えず、「送りたい日本語」をそのまま投げて大丈夫です。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: baseQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// 設定画面
async function replySettings(replyToken, user) {
  // 現在設定でのイメージ英文を1つ生成
  let exampleEn = '';
  try {
    exampleEn = await generateEnglishFromJapanese({
      user,
      sourceText: SAMPLE_JA,
      toneOverride: null,
    });
  } catch (e) {
    console.error('Settings example error:', e);
  }

  let text =
    '⚙️ 設定メニュー\n\n' +
    'どれがいいかよく分からない場合は、\n' +
    '「🧩 かんたん設定」でまとめて設定するのがおすすめです。\n\n' +
    '【いまの設定】\n' +
    `・レベル: ${levelLabel(user)}\n` +
    `・用途: ${usageSceneLabel(user.usage_default)}\n` +
    `・文体: ${toneLabel(user.tone_default)}\n\n`;

  if (exampleEn) {
    text +=
      'この設定だと、たとえば次の日本語はこんな英文になります：\n\n' +
      `日本語：${SAMPLE_JA}\n` +
      `英語：${exampleEn}`;
  } else {
    text += 'この設定に合わせて英文を作ります。日本語を送って試してみてください。';
  }

  const message = {
    type: 'text',
    text,
    quickReply: { items: settingsQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- レベル設定 --

async function replyLevelRoot(replyToken) {
  const message = {
    type: 'text',
    text:
      'レベルの決め方を選んでください。\n\n' +
      'レベル選びがよく分からない場合は、\n' +
      'かんたんに決められる「🧩 かんたん設定」から、\n' +
      '欲しい英文の雰囲気で選ぶ方法もあります。',
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
        ...baseQuickReplyItems(),
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyLevelEiken(replyToken) {
  const message = {
    type: 'text',
    text:
      '英検の級を選んでください。\n\n' +
      'どの級がよいか迷うときは、\n' +
      'いったん感覚で選んでから、実際に英文を出して様子を見る感じでOKです。',
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
        ...baseQuickReplyItems(),
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetLevelEiken(replyToken, user, text) {
  const code = text.replace('SET_LEVEL_EIKEN_', ''); // 5,4,3,PRE2,2,PRE1,1
  let value = code.toLowerCase(); // 'pre2', 'pre1', etc.

  const updated = await updateUser(user.line_user_id, {
    level_type: 'eiken',
    level_value: value,
  });

  // このレベルでのイメージ英文
  let exampleEn = '';
  try {
    exampleEn = await generateEnglishFromJapanese({
      user: updated,
      sourceText: SAMPLE_JA,
      toneOverride: null,
    });
  } catch (e) {
    console.error('Eiken level example error:', e);
  }

  let textBody =
    `レベルを「英検${levelLabel(updated)}」のイメージで登録しました。\n` +
    '同じ日本語でも、このくらいの雰囲気の英文になります。\n\n' +
    `日本語：${SAMPLE_JA}\n`;

  if (exampleEn) {
    textBody += `英語：${exampleEn}\n\n`;
  }

  textBody += '日本語か英語で文を送って、実際の出方を試してみてください。';

  const message = {
    type: 'text',
    text: textBody,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- 用途設定 --

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
        ...baseQuickReplyItems(),
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
    text: `よく使う場面を「${usageSceneLabel(updated.usage_default)}」として登録しました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- 文体設定 --

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
        ...baseQuickReplyItems(),
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
    text: `デフォルト文体を「${toneLabel(updated.tone_default)}」にしました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- 英語タイプ設定 --

async function replyEnglishStyle(replyToken) {
  const message = {
    type: 'text',
    text:
      '英語の雰囲気を選んでください。\n\n' +
      '迷ったら「日本人向け（無難）」でOKです。\n' +
      'アメリカ寄り / イギリス寄りは、ニュアンスの違いを少し大事にしたい人向けです。',
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
            label: 'アメリカ寄り',
            text: 'SET_EN_STYLE_AMERICAN',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'イギリス寄り',
            text: 'SET_EN_STYLE_BRITISH',
          },
        },
        ...baseQuickReplyItems(),
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

  const message = {
    type: 'text',
    text: `英語の雰囲気を「${englishStyleLabel(updated.english_style)}」にしました。`,
    quickReply: { items: baseQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- かんたん設定 --

async function replyEasySetup(replyToken) {
  const candidates = await generateEasySetupCandidates();

  let text =
    '🧩 かんたん設定\n\n' +
    '同じ日本語を、4パターンの英語にしてみました。\n' +
    '「自分だったらこの日本語こう書くな」と思う番号を選んでください。\n\n' +
    `日本語：${SAMPLE_JA}\n\n` +
    `① ${candidates[0]}\n` +
    `② ${candidates[1]}\n` +
    `③ ${candidates[2]}\n` +
    `④ ${candidates[3]}\n`;

  const message = {
    type: 'text',
    text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '① を選ぶ', text: 'SET_EASY_PROFILE_1' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '② を選ぶ', text: 'SET_EASY_PROFILE_2' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '③ を選ぶ', text: 'SET_EASY_PROFILE_3' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '④ を選ぶ', text: 'SET_EASY_PROFILE_4' },
        },
        ...baseQuickReplyItems(),
      ],
    },
  };

  return lineClient.replyMessage(replyToken, message);
}

async function handleEasyProfileSelect(replyToken, user, text) {
  // かんたん設定では「ざっくりレベル＋用途＋文体」をまとめて決める
  let profileNum = 1;
  if (text === 'SET_EASY_PROFILE_2') profileNum = 2;
  if (text === 'SET_EASY_PROFILE_3') profileNum = 3;
  if (text === 'SET_EASY_PROFILE_4') profileNum = 4;

  let level_value = String(profileNum); // rough 1–4
  let usage = 'CHAT_FRIEND';
  let tone = 'casual';

  if (profileNum === 1) {
    // 友だち・同僚チャット × カジュアル
    usage = 'CHAT_FRIEND';
    tone = 'casual';
  } else if (profileNum === 2) {
    // チャット〜社内向け × 丁寧寄り
    usage = 'CHAT_FRIEND';
    tone = 'polite';
  } else if (profileNum === 3) {
    // 社内メール × 丁寧
    usage = 'MAIL_INTERNAL';
    tone = 'polite';
  } else if (profileNum === 4) {
    // 社外メール × ビジネス
    usage = 'MAIL_EXTERNAL';
    tone = 'business';
  }

  const updated = await updateUser(user.line_user_id, {
    level_type: 'rough',
    level_value,
    usage_default: usage,
    tone_default: tone,
  });

  const profileLabel = {
    1: '友だち・同僚チャット × カジュアル',
    2: 'チャット〜社内向け × 丁寧寄り',
    3: '社内メール × 丁寧',
    4: '社外メール × ビジネス',
  }[profileNum];

  const message = {
    type: 'text',
    text:
      `🧩 かんたん設定「${profileLabel}」を選びました。\n\n` +
      'このイメージに合わせて英文を作ります。\n' +
      '日本語か英語で文を送って、実際の出方を試してみてください。',
    quickReply: { items: baseQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- トーン変更 --

async function handleToneChange(replyToken, user, toneLabelJa) {
  if (!user.last_source_ja) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って英文を作ってから、文体を変えてみてください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }

  let toneOverride = user.tone_default;
  let comment = '';

  if (toneLabelJa.includes('カジュアル')) {
    toneOverride = 'casual';
    comment = 'カジュアルな場面なら、このまま使えます。';
  } else if (toneLabelJa.includes('丁寧')) {
    toneOverride = 'polite';
    comment = '丁寧なやりとりなら、このまま使えます。';
  } else if (toneLabelJa.includes('ビジネス')) {
    toneOverride = 'business';
    comment = 'ビジネスでも、このまま使えます。';
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
    text: comment ? `${en}\n\n（${comment}）` : en,
    quickReply: { items: toneQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- 「この英文でOK」 --

async function handleAcceptCurrentEnglish(replyToken, user) {
  const en = user.last_output_en;
  if (!en) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って、英文を作ってから選んでください。',
      quickReply: { items: baseQuickReplyItems() },
    });
  }

  const copyMessage = {
    type: 'text',
    text: en,
  };

  const systemPrompt = `
You are an English coach for Japanese learners.
The user has just decided to use the following English sentence.
Give ONE short upgrade example and a brief explanation in Japanese.

Rules:
- Output in Japanese, except for the example English sentence.
- 3–5 lines.
- Tone: friendly and supportive, not teacher-ish.
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

// -- 日本語 → 英語 --

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

// -- 英語 → 日本語（和訳＋語彙解説） --

async function handleEnToJa(text, replyToken, user, options = {}) {
  const { ja, glossary } = await explainEnglishToJapaneseWithGlossary({
    user,
    sourceText: text,
  });

  let resultText = ja;
  if (glossary && glossary.length > 0) {
    resultText += '\n\n◆チェックしておきたい単語・表現\n';
    glossary.forEach((g) => {
      if (!g.term) return;
      const term = g.term;
      const meaning = g.meaning_ja || '';
      const note = g.note_ja ? `（${g.note_ja}）` : '';
      resultText += `・${term}: ${meaning}${note}\n`;
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

// -- 日本語＋英語混在 --

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
