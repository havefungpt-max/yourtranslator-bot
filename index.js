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

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

  // デフォルト値（DB 側の NOT NULL / DEFAULT に依存しない）
  const now = new Date().toISOString();
  const newUser = {
    line_user_id: lineUserId,
    level_type: 'eiken',           // 'eiken' | 'toeic' | 'rough'
    level_value: '2',              // '5','4','3','pre2','2','pre1','1' など
    english_style: 'japanese',     // UI上は固定で扱う
    usage_default: 'CHAT_FRIEND',  // 'CHAT_FRIEND' | 'MAIL_INTERNAL' | 'MAIL_EXTERNAL'
    tone_default: 'polite',        // 'casual' | 'polite' | 'business'
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
  // 英語判定は小文字のみを見る：AI / DB だけで英語扱いしない
  const hasEn = /[a-z]/.test(text);

  if (hasJa && hasEn) return 'mixed';
  if (hasJa) return 'ja';
  if (hasEn) return 'en';
  return 'other';
}

// ---------- ヘルパー：Quick Reply ----------

function settingsQuickReplyItem() {
  return {
    type: 'action',
    action: { type: 'message', label: '⚙ 設定', text: 'ホーム' },
  };
}

// includeHelp = true のときだけ「使い方」も出す
function baseQuickReplyItems(includeHelp = true) {
  const items = [settingsQuickReplyItem()];
  if (includeHelp) {
    items.push({
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    });
  }
  return items;
}

// 英文生成時のクイックメニュー
function toneQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '✨ この英文でOK', text: 'この英文でOK' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '😊 カジュアルに', text: 'トーン:カジュアル' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '🙂 丁寧に', text: 'トーン:丁寧' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '💼 ビジネスに', text: 'トーン:ビジネス' },
    },
    settingsQuickReplyItem(),
  ];
}

// ホーム画面用の設定ボタン列
function homeQuickReplyItems() {
  return [
    {
      type: 'action',
      action: { type: 'message', label: '🎯 レベル', text: '[設定] レベル' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '📮 用途', text: '[設定] 用途' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '🎨 文体', text: '[設定] 文体' },
    },
    {
      type: 'action',
      action: { type: 'message', label: '❓ 使い方', text: '使い方' },
    },
  ];
}

// ---------- 表示ラベル系 ----------

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
      return '丁寧（フラット）';
  }
}

// いちおう残しておくが UI では使わない
function englishStyleLabel(style) {
  if (style === 'american') return 'アメリカ英語';
  if (style === 'british') return 'イギリス英語';
  return '日本人英語';
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
        return '英検レベル（ざっくり）';
    }
  }
  if (user.level_type === 'toeic') {
    const v = user.level_value || '';
    switch (v) {
      case 'under400':
        return 'TOEIC 〜400 くらい';
      case '400_600':
        return 'TOEIC 400–600 くらい';
      case '600_800':
        return 'TOEIC 600–800 くらい';
      case 'over800':
        return 'TOEIC 800+ くらい';
      default:
        return 'TOEIC レベル（ざっくり）';
    }
  }
  return 'ざっくりレベル';
}

// ホーム表示用（設定内容は出さない）
function buildHomeText(user) {
  return (
    '🏠 YourTranslator ホーム\n\n' +
    '翻訳したい日本語か英語の文を、そのまま送ってください。\n\n' +
    '設定を変えたいときは、下のボタンからどうぞ。'
  );
}

// 設定内容を出したいときはこちらを使う
function buildSettingsSummary(user) {
  return (
    'いまの設定はこんな感じです：\n' +
    `・レベル：${levelLabel(user)}\n` +
    `・よく使う場面：${usageSceneLabel(user.usage_default)}\n` +
    `・文体：${toneLabel(user.tone_default)}\n`
  );
}

// ---------- OpenAI 呼び出し ----------

async function generateEnglishFromJapanese({ user, sourceText, toneOverride }) {
  const levelText =
    user.level_type === 'eiken'
      ? levelLabel(user)
      : user.level_type === 'toeic'
      ? levelLabel(user)
      : `rough level ${user.level_value || ''}`;

  const usageText = {
    CHAT_FRIEND: 'casual chat message with friends or colleagues',
    MAIL_INTERNAL: 'polite internal business email inside a company',
    MAIL_EXTERNAL: 'formal external business email to customers or partners',
  }[user.usage_default] || 'casual chat message with friends or colleagues';

  const tone = toneOverride || user.tone_default; // 'casual' | 'polite' | 'business'

  // スタイルは基本「日本人英語」想定
  let englishStyleText;
  switch (user.english_style) {
    case 'american':
      englishStyleText =
        'American English: use natural US-style expressions, but avoid slang unless the tone is very casual.';
      break;
    case 'british':
      englishStyleText =
        'British English: use natural UK-style expressions and spelling where relevant (e.g., organise, colour).';
      break;
    case 'japanese':
    case 'neutral':
    default:
      englishStyleText =
        'Japanese learner English: globally understandable, safe, slightly modest tone, avoid heavy slang.';
      break;
  }

  const systemPrompt = `
You are an English writing assistant for Japanese users.

Concept:
- The goal is to create sentences that feel like:
  "This is how I would naturally write it," given the user's level, usual style, and context.

Rules:
- When the user sends Japanese, translate or rewrite it into natural English.
- Consider the user's level, usage scene, tone, and English style carefully.
- Usage scene:
  - "casual chat message with friends or colleagues": more spoken, relaxed style.
  - "polite internal business email inside a company": written, polite, but not too stiff.
  - "formal external business email to customers or partners": more formal written business style.
- Tone:
  - "casual": use contractions (I'm, don't), natural spoken phrases, a friendly tone.
  - "polite": neutral and polite, suitable for general business communication.
  - "business": more formal, structured, and careful, but still concise.
- IMPORTANT: If the tone changes (casual / polite / business), you MUST change wording or structure accordingly.
  Never return exactly the same sentence for different tones.
- English style:
  Follow the description given (Japanese learner English / American English / British English).

Output:
- Output ONLY the English sentence(s).
- No Japanese. No explanations. No quotes.
- No bullet points unless the source text clearly uses multiple items.
`.trim();

  const userPrompt = `
User level (approx): ${levelText}
Usage scene: ${usageText}
Tone: ${tone}
English style: ${englishStyleText}

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
      ? levelLabel(user)
      : user.level_type === 'toeic'
      ? levelLabel(user)
      : `rough level ${user.level_value || ''}`;

  const systemPrompt = `
You are an English-to-Japanese translator and tutor for Japanese learners.

Concept:
- Focus on words and expressions that are likely to be unfamiliar or slightly above the user's level.
- Do NOT waste space on very basic words (e.g., good, go, big, today).

Tasks:
1. Translate the English text into natural Japanese.
2. Pick 0–5 words or expressions that might be difficult for the user (based on the given level).
3. For each, provide:
   - the English term
   - a short Japanese meaning
   - an optional short note in Japanese (1 sentence), e.g. nuance or a "movie-style" paraphrase.

User level will be given (e.g., EIKEN or TOEIC band), so keep explanations simple.

Return ONLY a JSON object with this shape:

{
  "ja": "自然な日本語訳",
  "glossary": [
    {
      "term": "英単語や表現（必ず英語で）",
      "meaning_ja": "日本語の意味（1フレーズ）",
      "note_ja": "やさしい日本語での補足（1文以内。映画のセリフ風の意訳コメントがあってもよい）"
    }
  ]
}

Rules:
- Pick vocabulary or expressions that are slightly above or around the user's level.
- Avoid very basic, textbook-level vocabulary.
- Each "note_ja" should be short (ideally one short sentence).
- No extra text. No comments. No Markdown. No backticks.
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

async function generateOnePointLesson(en) {
  const systemPrompt = `
You are an English coach for Japanese learners.
The user has decided to use the following English sentence(s).
You will give a friendly, polite "native-like" suggestion.

Concept:
- Do NOT blame or correct the user.
- Assume the sentence is already acceptable.
- You just show: "If a native speaker said it, it might sound like this."

Output format (in Japanese, except for the English example):

✨ よりネイティブに近づけた表現なら、たとえば:
<one native-like English example>

🔎 ポイント:
・どんな場面・ニュアンスでよく使われるかを2〜3行で説明
・「こういう言い方もよく使われます」「この表現は〜という雰囲気です」のように、
  追加の選択肢として紹介する
・余裕があれば、1つの単語や表現について軽く由来やイメージ（root やニュアンス）を1行だけ触れてもよい

Rules:
- Do NOT restate the original user sentence.
- Total 3〜7行くらいに収める。
- トーンはフレンドリーで、上から目線にならない。
- 日本語はできるだけシンプルに。
`.trim();

  const userPrompt = `User sentence (already acceptable):\n${en}`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
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
    return handleJaToEn(original, event.replyToken, user, { force: 'en' });
  }
  if (text.startsWith('TRANSLATE_TO_JA:::')) {
    const original = text.replace('TRANSLATE_TO_JA:::', '');
    return handleEnToJa(original, event.replyToken, user, { force: 'ja' });
  }

  // 簡易テスト系
  if (text === '今すぐテストしてみる') {
    return replyLevelTestIntro(event.replyToken);
  }
  if (text.startsWith('テスト結果:')) {
    return handleTestResult(event.replyToken, user, text);
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
  if (text === '[設定] TOEICレベル') {
    return replyLevelToeic(event.replyToken);
  }
  if (text === '[設定] かんたんプリセット') {
    return replyLevelPreset(event.replyToken);
  }
  if (text.startsWith('SET_LEVEL_EIKEN_')) {
    return handleSetLevelEiken(event.replyToken, user, text);
  }
  if (text.startsWith('SET_LEVEL_TOEIC_')) {
    return handleSetLevelToeic(event.replyToken, user, text);
  }
  if (text.startsWith('SET_LEVEL_PRESET_')) {
    return handleSetLevelPreset(event.replyToken, user, text);
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

  // トーン変更
  if (text.startsWith('トーン:')) {
    const toneLabelJa = text.replace('トーン:', '');
    return handleToneChange(event.replyToken, user, toneLabelJa);
  }

  // 「この英文でOK」 → ネイティブ寄りの別案（ユーザー英文は再掲しない）
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
      text: '今は日本語と英語だけをサポートしています。\n日本語か英語で送ってみてください。',
      quickReply: { items: baseQuickReplyItems(false) },
    });
  }
}

// ---------- 各種返信ハンドラ ----------

async function replyHelp(replyToken) {
  const message = {
    type: 'text',
    text:
      '💡 YourTranslator へようこそ\n\n' +
      'YourTranslator は、キレイすぎる翻訳ツールや AI の英語ではなく、\n' +
      'あなたが普段使いそうな自然な英文と、ワンランク上の英文を提案する相棒です。\n\n' +
      '📝 できること\n' +
      '・日本語で送る → 英文を作成\n' +
      '・英語で送る → 和訳＋ちょっとむずかしめの英単語・表現のミニ解説\n' +
      '・日本語＋英語まじり → 英訳 / 和訳を選択\n\n' +
      '⚙️ 設定のイメージ\n' +
      '・レベル → 単語・文法のむずかしさ\n' +
      '・用途 → チャット / 社内メール / 社外メール\n' +
      '・文体 → カジュアル / 丁寧 / ビジネス\n' +
      '同じ日本語でも、用途や文体を変えると「語尾・前置き・ていねいさ」が変わります。\n\n' +
      '✨ 「この英文でOK」を押すと\n' +
      '・今の英文はそのままOK、という前提で\n' +
      '・「よりネイティブに近づけた表現なら、たとえばこんな言い方もあります」という別案＋日本語でのポイント解説が返ってきます。\n' +
      '  （あなたの英文をダメ出しするのではなく、「こういう言い方もあるよ」を足すイメージです）\n\n' +
      'まずは、翻訳したい日本語か英語の文をそのまま送ってみてください。',
    quickReply: { items: baseQuickReplyItems(true) },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyHome(replyToken, user) {
  const text = buildHomeText(user);
  const message = {
    type: 'text',
    text,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function replyUsage(replyToken) {
  const text =
    '📖 使い方ガイド\n\n' +
    '1️⃣ まずは設定\n' +
    '・「ホーム」→ レベル / 用途 / 文体 をざっくり決める\n' +
    '・「🎯 レベル」から、英検 / TOEIC / かんたんテスト で自分のレベルを選ぶ\n\n' +
    '2️⃣ 日本語で送ると…\n' +
    '・そのままの意味で使える英文にして返します\n' +
    '・レベル・用途・文体に合わせて、言い回しや丁寧さを調整します\n\n' +
    '3️⃣ 英語で送ると…\n' +
    '・自然な日本語訳\n' +
    '・あなたのレベルから見て「ちょっとむずかしい」英単語・表現のミニ解説\n\n' +
    '4️⃣ 日本語＋英語がまざるとき\n' +
    '・「英訳してほしい」「和訳してほしい」のボタンが出るので、どちらかを選びます\n\n' +
    '5️⃣ さらに調整したいとき\n' +
    '・「カジュアルに / 丁寧に / ビジネスに」を押すと文体だけ変えた英文に\n' +
    '・「この英文でOK」を押すと、\n' +
    '   → よりネイティブに近づけた表現の別案＋日本語のポイント解説が返ってきます\n\n' +
    'むずかしく考えなくて大丈夫なので、まずはいつもの文をそのまま投げてみてください。';

  const message = {
    type: 'text',
    text,
    quickReply: { items: baseQuickReplyItems(true) },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- 簡易レベルテスト --

async function replyLevelTestIntro(replyToken) {
  const text =
    '📘 かんたんレベルチェック\n\n' +
    '次の3つの英文のうち、「自分ならこう書きそうだな」と感じるものを選んでください。\n' +
    '番号が大きくなるほど、単語や文法のレベルが少しずつ上がっていきます。\n\n' +
    '1) I like watching movies and playing games in my free time.\n' +
    "2) I'd really appreciate it if you could share the updated schedule when you have a moment.\n" +
    '3) We need to prioritize this task, otherwise it may negatively affect the project timeline.\n\n' +
    '「テスト結果: 2」のように、番号つきで送ってください。';

  const message = {
    type: 'text',
    text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '①', text: 'テスト結果: 1' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '②', text: 'テスト結果: 2' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '③', text: 'テスト結果: 3' },
        },
        ...baseQuickReplyItems(true),
      ],
    },
  };

  return lineClient.replyMessage(replyToken, message);
}

async function handleTestResult(replyToken, user, text) {
  const numStr = text.replace('テスト結果:', '').trim();
  const num = parseInt(numStr, 10);

  let level_value = user.level_value;
  switch (num) {
    case 1:
      level_value = '5';
      break;
    case 2:
      level_value = '3';
      break;
    case 3:
      level_value = 'pre2';
      break;
    default:
      return lineClient.replyMessage(replyToken, {
        type: 'text',
        text:
          '1〜3のどれかで答えてください。\n' +
          '例：「テスト結果: 2」',
        quickReply: { items: baseQuickReplyItems(true) },
      });
  }

  const updated = await updateUser(user.line_user_id, {
    level_type: 'eiken',
    level_value,
  });

  const textReply =
    `📝 テスト結果から、レベルを「${levelLabel(updated)}」あたりにしてみました。\n\n` +
    buildSettingsSummary(updated);

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- レベル設定 --

async function replyLevelRoot(replyToken) {
  const message = {
    type: 'text',
    text:
      '🎯 レベルの決め方を選んでください。\n\n' +
      '・英検：あなたの英語力を英検の級で設定する\n' +
      '・TOEIC：TOEICスコア帯でレベルを設定する\n' +
      '・かんたんテスト：3つの英文から感覚で選ぶだけ\n' +
      '・とりあえず決めたい：出したい英文のイメージからまとめて設定\n\n' +
      '例）\n' +
      '・英検3級イメージ：I went to Tokyo with my family last weekend.\n' +
      '・英検1級イメージ：We need to align on our long-term strategy before making this decision.',
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '英検で設定', text: '[設定] 英検レベル' },
        },
        {
          type: 'action',
          action: { type: 'message', label: 'TOEICで設定', text: '[設定] TOEICレベル' },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'かんたんテスト',
            text: '今すぐテストしてみる',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: 'とりあえず決めたい',
            text: '[設定] かんたんプリセット',
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

async function replyLevelToeic(replyToken) {
  const message = {
    type: 'text',
    text: 'TOEIC のだいたいのスコア帯を選んでください。',
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'message',
            label: '〜400',
            text: 'SET_LEVEL_TOEIC_UNDER400',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '400〜600',
            text: 'SET_LEVEL_TOEIC_400_600',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '600〜800',
            text: 'SET_LEVEL_TOEIC_600_800',
          },
        },
        {
          type: 'action',
          action: {
            type: 'message',
            label: '800〜',
            text: 'SET_LEVEL_TOEIC_OVER800',
          },
        },
      ],
    },
  };
  return lineClient.replyMessage(replyToken, message);
}

// 「とりあえず決めたい」用：イメージで4択
async function replyLevelPreset(replyToken) {
  const text =
    '🧩 出してほしい英文のイメージを選んでください。\n\n' +
    '1) やさしめのシンプル英語（友だち・同僚チャット中心）\n' +
    '2) ふつうのビジネス英語（社内メール中心）\n' +
    '3) かっちりめのビジネス英語（社外メール中心）\n' +
    '4) かなりネイティブ寄りの英語でもOK\n\n' +
    'あとで細かく変えたくなったら、「ホーム」からレベルや用途を調整できます。';

  const message = {
    type: 'text',
    text,
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'message', label: '①', text: 'SET_LEVEL_PRESET_1' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '②', text: 'SET_LEVEL_PRESET_2' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '③', text: 'SET_LEVEL_PRESET_3' },
        },
        {
          type: 'action',
          action: { type: 'message', label: '④', text: 'SET_LEVEL_PRESET_4' },
        },
      ],
    },
  };

  return lineClient.replyMessage(replyToken, message);
}

async function handleSetLevelEiken(replyToken, user, text) {
  const code = text.replace('SET_LEVEL_EIKEN_', '').toUpperCase(); // 5,4,3,PRE2,2,PRE1,1
  let value;
  switch (code) {
    case '5':
    case '4':
    case '3':
    case '2':
    case '1':
      value = code;
      break;
    case 'PRE2':
      value = 'pre2';
      break;
    case 'PRE1':
      value = 'pre1';
      break;
    default:
      value = '2';
  }

  const updated = await updateUser(user.line_user_id, {
    level_type: 'eiken',
    level_value: value,
  });

  const textReply =
    `🎯 レベルを「${levelLabel(updated)}」のイメージで登録しました。\n\n` +
    buildSettingsSummary(updated);

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetLevelToeic(replyToken, user, text) {
  let value = '400_600';
  if (text === 'SET_LEVEL_TOEIC_UNDER400') value = 'under400';
  if (text === 'SET_LEVEL_TOEIC_400_600') value = '400_600';
  if (text === 'SET_LEVEL_TOEIC_600_800') value = '600_800';
  if (text === 'SET_LEVEL_TOEIC_OVER800') value = 'over800';

  const updated = await updateUser(user.line_user_id, {
    level_type: 'toeic',
    level_value: value,
  });

  const textReply =
    `🎯 レベルを「${levelLabel(updated)}」のイメージで登録しました。\n\n` +
    buildSettingsSummary(updated);

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

async function handleSetLevelPreset(replyToken, user, text) {
  const code = text.replace('SET_LEVEL_PRESET_', '').trim();
  let patch = {};

  if (code === '1') {
    patch = {
      level_type: 'eiken',
      level_value: '5',
      usage_default: 'CHAT_FRIEND',
      tone_default: 'casual',
    };
  } else if (code === '2') {
    patch = {
      level_type: 'eiken',
      level_value: '3',
      usage_default: 'MAIL_INTERNAL',
      tone_default: 'polite',
    };
  } else if (code === '3') {
    patch = {
      level_type: 'eiken',
      level_value: 'pre1',
      usage_default: 'MAIL_EXTERNAL',
      tone_default: 'business',
    };
  } else if (code === '4') {
    patch = {
      level_type: 'eiken',
      level_value: '1',
      usage_default: 'MAIL_EXTERNAL',
      tone_default: 'business',
    };
  } else {
    // 想定外の値なら何もしない
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: '1〜4のどれかを選んでください。',
      quickReply: { items: baseQuickReplyItems(true) },
    });
  }

  const updated = await updateUser(user.line_user_id, patch);

  const textReply =
    '🧩 ざっくり設定を反映しました。\n\n' +
    buildSettingsSummary(updated) +
    '\nあとから細かく変えたくなったら、「ホーム」→ 各設定ボタンから調整できます。';

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- 用途設定 --

async function replyUsageScene(replyToken) {
  const message = {
    type: 'text',
    text:
      '📮 よく使う場面を選んでください。\n\n' +
      '同じ内容でも、場面によって英語が少し変わります。\n\n' +
      '例）「明日のランチ、一緒にどう？」\n' +
      '・友だち・同僚チャット：Let\'s grab lunch tomorrow.\n' +
      '・社内メール：Could we have lunch together tomorrow?\n' +
      '・社外メール：I was wondering if you would be available for lunch tomorrow.',
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

  const textReply =
    `📮 よく使う場面を「${usageSceneLabel(updated.usage_default)}」として登録しました。\n\n` +
    buildSettingsSummary(updated);

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- 文体設定 --

async function replyToneSetting(replyToken) {
  const message = {
    type: 'text',
    text:
      '🎨 よく使う文体を選んでください。\n\n' +
      '例）「これ、確認してもらえますか？」\n' +
      '・カジュアル：Can you check this?\n' +
      '・丁寧：Could you take a look at this?\n' +
      '・ビジネス：I would appreciate it if you could review this.',
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

  const textReply =
    `🎨 文体を「${toneLabel(updated.tone_default)}」にしました。\n\n` +
    buildSettingsSummary(updated);

  const message = {
    type: 'text',
    text: textReply,
    quickReply: { items: homeQuickReplyItems() },
  };
  return lineClient.replyMessage(replyToken, message);
}

// -- トーン変更 --

async function handleToneChange(replyToken, user, toneLabelJa) {
  if (!user.last_source_ja) {
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: 'まず日本語の文を送って英文を作ってから、文体を変えてみてください。',
      quickReply: { items: baseQuickReplyItems(false) },
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

  const updated = await updateUser(user.line_user_id, {
    last_output_en: en,
    last_mode: 'JA_TO_EN',
  });

  const message = {
    type: 'text',
    text: updated.last_output_en || en,
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
      quickReply: { items: baseQuickReplyItems(false) },
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
      (lessonText
        ? '✨ よりネイティブに近づけた表現なら、たとえば\n------------------------------\n' + lessonText
        : 'ネイティブ寄りの別案の生成に失敗しましたが、英文自体はそのまま使って大丈夫です。'),
    quickReply: { items: baseQuickReplyItems(false) },
  };

  return lineClient.replyMessage(replyToken, message);
}

// -- 日本語 → 英語 --

async function handleJaToEn(text, replyToken, user, options = {}) {
  const en = await generateEnglishFromJapanese({
    user,
    sourceText: text,
    toneOverride: null,
  });

  const updated = await updateUser(user.line_user_id, {
    last_source_ja: text,
    last_output_en: en,
    last_mode: 'JA_TO_EN',
  });

  const message = {
    type: 'text',
    text: updated.last_output_en || en,
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
    resultText += '\n\n📚 チェックしておきたい単語・表現\n';
    glossary.forEach((g) => {
      if (!g.term) return;
      const meaning = g.meaning_ja || '';
      const note = g.note_ja || '';
      if (meaning && note) {
        resultText += `・${g.term}: ${meaning}（${note}）\n`;
      } else if (meaning) {
        resultText += `・${g.term}: ${meaning}\n`;
      } else if (note) {
        resultText += `・${g.term}: （${note}）\n`;
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
    quickReply: { items: baseQuickReplyItems(false) },
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
        ...baseQuickReplyItems(true),
      ],
    },
  };

  return lineClient.replyMessage(replyToken, message);
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
