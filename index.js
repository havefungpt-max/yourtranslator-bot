// index.js

const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// -----------------------
// 環境変数
// -----------------------
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const client = new Client(config);
const app = express();

// -----------------------
// 簡易メモリ（最後の英文など）
// key = lineUserId
// value = { lastSourceText, lastCandidate, lastTone }
// -----------------------
const userContext = new Map();

// -----------------------
// ユーザー設定のデフォルト
// -----------------------
const DEFAULT_SETTINGS = {
  english_level_type: 'EIKEN',          // 'EIKEN' | 'TOEIC'
  english_level_value: 'EIKEN_2',       // 例: EIKEN_2 / TOEIC_600_799
  english_style_default: 'POLITE',      // 'CASUAL' | 'POLITE' | 'BUSINESS'
  english_variant: 'JP',                // 'JP' | 'US' | 'UK'
};

// -----------------------
// Supabase: ユーザー取得・作成・更新
// -----------------------
async function getOrCreateUserSettings(lineUserId) {
  // 既存確認
  const { data, error } = await supabase
    .from('user_settings')
    .select('*')
    .eq('line_user_id', lineUserId)
    .maybeSingle();

  if (error) {
    console.error('Supabase get user error:', error);
    // Supabase死んでる場合でも動くようにメモリだけで返す
    return { line_user_id: lineUserId, ...DEFAULT_SETTINGS };
  }

  if (data) {
    return data;
  }

  // なければ作成
  const insertData = {
    line_user_id: lineUserId,
    ...DEFAULT_SETTINGS,
  };

  const { data: inserted, error: insertError } = await supabase
    .from('user_settings')
    .insert(insertData)
    .select('*')
    .single();

  if (insertError) {
    console.error('Supabase insert user error:', insertError);
    return { line_user_id: lineUserId, ...DEFAULT_SETTINGS };
  }

  return inserted;
}

async function updateUserSettings(lineUserId, updates) {
  const payload = {
    ...updates,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('user_settings')
    .update(payload)
    .eq('line_user_id', lineUserId)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('Supabase update user error:', error);
    return null;
  }

  return data;
}

// -----------------------
// Quick Reply builder
// -----------------------
function buildQuickReply(extraActions = []) {
  const items = [
    ...extraActions.map((action) => ({
      type: 'action',
      action,
    })),
    {
      type: 'action',
      action: {
        type: 'message',
        label: '🏠 ホーム',
        text: 'ホーム',
      },
    },
  ];

  return { items };
}

// -----------------------
// 設定値 → 表示テキスト
// -----------------------
function describeLevel(settings) {
  if (settings.english_level_type === 'EIKEN') {
    switch (settings.english_level_value) {
      case 'EIKEN_5':
        return '英検5級';
      case 'EIKEN_4':
        return '英検4級';
      case 'EIKEN_3':
        return '英検3級';
      case 'EIKEN_2':
        return '英検2級';
      case 'EIKEN_1':
        return '英検1級';
      default:
        return '英検2級相当';
    }
  } else if (settings.english_level_type === 'TOEIC') {
    switch (settings.english_level_value) {
      case 'TOEIC_0_399':
        return 'TOEIC 〜399';
      case 'TOEIC_400_599':
        return 'TOEIC 400〜599';
      case 'TOEIC_600_799':
        return 'TOEIC 600〜799';
      case 'TOEIC_800_895':
        return 'TOEIC 800〜895';
      case 'TOEIC_900_990':
        return 'TOEIC 900〜990';
      default:
        return 'TOEIC 600〜799';
    }
  }
  return '英検2級相当';
}

function describeTone(settings) {
  switch (settings.english_style_default) {
    case 'CASUAL':
      return 'カジュアル';
    case 'BUSINESS':
      return 'ビジネス';
    case 'POLITE':
    default:
      return '丁寧';
  }
}

function describeVariant(settings) {
  switch (settings.english_variant) {
    case 'US':
      return 'US英語';
    case 'UK':
      return 'UK英語';
    case 'JP':
    default:
      return '日本人向け（無難）';
  }
}

// -----------------------
// GPT 用 System Prompt
// -----------------------
function buildSystemPrompt(settings, toneOverride) {
  const levelText = describeLevel(settings);
  const variantText = describeVariant(settings);

  const style = toneOverride || settings.english_style_default;

  let toneText = 'polite but natural English';
  if (style === 'CASUAL') {
    toneText = 'casual, friendly English';
  } else if (style === 'BUSINESS') {
    toneText = 'polite and formal business English';
  }

  let variantTextEn = 'You may mix US/UK spelling in a neutral way.';
  if (settings.english_variant === 'US') {
    variantTextEn = 'Use US English spelling and expressions.';
  } else if (settings.english_variant === 'UK') {
    variantTextEn = 'Use UK English spelling and expressions.';
  } else if (settings.english_variant === 'JP') {
    variantTextEn =
      'Use safe, clear English that Japanese business people often use in emails or chats.';
  }

  return `
You are an English rewriting assistant for Japanese learners.

- The user sends Japanese or English sentences for real communication (email, chat, etc.).
- Rewrite or translate them into natural English.

Target level:
- Approximately "${levelText}" level.

Tone:
- Use ${toneText}.

English variety:
- ${variantTextEn}

Rules:
- Output ONLY one English sentence (or a short paragraph) as the answer.
- Do NOT add Japanese explanations.
- Do NOT add extra commentary.
- Do NOT wrap the text in quotes.
`.trim();
}

function buildOnePointPrompt(settings, baseSentence) {
  const levelText = describeLevel(settings);
  const variantText = describeVariant(settings);

  return `
You are an English coach for Japanese learners.

Student profile:
- Level: ${levelText}
- English variety: ${variantText}

Base sentence:
${baseSentence}

Task:
- Suggest ONE slightly more advanced or natural alternative English sentence.
- Then, in Japanese, explain in at most 2 short sentences why it is a good expression or in what situation to use it.

Format:
英語: <improved English sentence>
解説: <short explanation in Japanese>
`.trim();
}

// -----------------------
// ホーム画面
// -----------------------
async function replyHomeMenu(replyToken, settings) {
  const text =
    `YourTranslator ホーム\n\n` +
    `現在の設定:\n` +
    `・レベル: ${describeLevel(settings)}\n` +
    `・英語タイプ: ${describeVariant(settings)}\n` +
    `・デフォルト文体: ${describeTone(settings)}\n\n` +
    `変更したい項目を選んでください。`;

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: 'レベルを変更',
      text: '[設定] レベル',
    },
    {
      type: 'message',
      label: '英語タイプ変更',
      text: '[設定] 英語タイプ',
    },
    {
      type: 'message',
      label: '文体を変更',
      text: '[設定] 文体',
    },
    {
      type: 'message',
      label: '使い方',
      text: '使い方',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

// -----------------------
// 設定メニュー系
// -----------------------
async function replyLevelMenu(replyToken) {
  const text = 'レベルの決め方を選んでください。';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: '英検で選ぶ',
      text: '[設定] 英検レベル',
    },
    {
      type: 'message',
      label: 'TOEICで選ぶ',
      text: '[設定] TOEICスコア',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

async function replyEikenMenu(replyToken) {
  const text = '英検の級を選んでください。';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: '英検5級',
      text: 'SET_LEVEL_EIKEN_5',
    },
    {
      type: 'message',
      label: '英検4級',
      text: 'SET_LEVEL_EIKEN_4',
    },
    {
      type: 'message',
      label: '英検3級',
      text: 'SET_LEVEL_EIKEN_3',
    },
    {
      type: 'message',
      label: '英検2級',
      text: 'SET_LEVEL_EIKEN_2',
    },
    {
      type: 'message',
      label: '英検1級',
      text: 'SET_LEVEL_EIKEN_1',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

async function replyToeicMenu(replyToken) {
  const text = 'TOEICのスコア帯を選んでください。';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: '〜399',
      text: 'SET_LEVEL_TOEIC_0_399',
    },
    {
      type: 'message',
      label: '400〜599',
      text: 'SET_LEVEL_TOEIC_400_599',
    },
    {
      type: 'message',
      label: '600〜799',
      text: 'SET_LEVEL_TOEIC_600_799',
    },
    {
      type: 'message',
      label: '800〜895',
      text: 'SET_LEVEL_TOEIC_800_895',
    },
    {
      type: 'message',
      label: '900〜990',
      text: 'SET_LEVEL_TOEIC_900_990',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

async function replyToneMenu(replyToken, settings) {
  const text =
    'デフォルトの文体を選んでください。\n' +
    '・カジュアル: 友達や同僚向け\n' +
    '・丁寧: 一般的なビジネスメール\n' +
    '・ビジネス: かっちりした文面';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: 'カジュアル',
      text: 'SET_TONE_CASUAL',
    },
    {
      type: 'message',
      label: '丁寧',
      text: 'SET_TONE_POLITE',
    },
    {
      type: 'message',
      label: 'ビジネス',
      text: 'SET_TONE_BUSINESS',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

async function replyVariantMenu(replyToken, settings) {
  const text =
    '英語のタイプを選んでください。\n' +
    '・日本人向け: 無難で分かりやすい表現\n' +
    '・US英語: アメリカ英語\n' +
    '・UK英語: イギリス英語';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: '日本人向け',
      text: 'SET_VARIANT_JP',
    },
    {
      type: 'message',
      label: 'US英語',
      text: 'SET_VARIANT_US',
    },
    {
      type: 'message',
      label: 'UK英語',
      text: 'SET_VARIANT_UK',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

// -----------------------
// 翻訳・リライト本体
// -----------------------
async function handleTranslate(lineUserId, replyToken, text) {
  const settings = await getOrCreateUserSettings(lineUserId);

  const systemPrompt = buildSystemPrompt(settings);

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
  });

  const english = (completion.choices[0].message.content || '').trim();

  // コンテキスト保存（再トーン・この英文で良い 用）
  userContext.set(lineUserId, {
    lastSourceText: text,
    lastCandidate: english,
    lastTone: settings.english_style_default,
  });

  const header =
    `【レベル: ${describeLevel(settings)} / 文体: ${describeTone(
      settings
    )} / 英語タイプ: ${describeVariant(settings)}】\n` +
    `------------------------------\n`;

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: 'カジュアル',
      text: 'カジュアル',
    },
    {
      type: 'message',
      label: '丁寧',
      text: '丁寧',
    },
    {
      type: 'message',
      label: 'ビジネス',
      text: 'ビジネス',
    },
    {
      type: 'message',
      label: 'この英文で良い',
      text: 'この英文で良い',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text: header + english,
    quickReply,
  });
}

async function handleRetone(lineUserId, replyToken, toneLabel) {
  const ctx = userContext.get(lineUserId);
  if (!ctx || !ctx.lastSourceText) {
    const quickReply = buildQuickReply([]);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '直近の文章が見つかりません。もう一度文章を送ってください。',
      quickReply,
    });
  }

  const settings = await getOrCreateUserSettings(lineUserId);

  let toneOverride = settings.english_style_default;
  if (toneLabel === 'カジュアル') toneOverride = 'CASUAL';
  if (toneLabel === '丁寧') toneOverride = 'POLITE';
  if (toneLabel === 'ビジネス') toneOverride = 'BUSINESS';

  const systemPrompt = buildSystemPrompt(settings, toneOverride);

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: ctx.lastSourceText },
    ],
  });

  const english = (completion.choices[0].message.content || '').trim();

  // 更新
  userContext.set(lineUserId, {
    lastSourceText: ctx.lastSourceText,
    lastCandidate: english,
    lastTone: toneOverride,
  });

  // header用に一時的に style を書き換えたコピーを作る
  const displaySettings = {
    ...settings,
    english_style_default: toneOverride,
  };

  const header =
    `【レベル: ${describeLevel(displaySettings)} / 文体: ${describeTone(
      displaySettings
    )} / 英語タイプ: ${describeVariant(displaySettings)}】\n` +
    `------------------------------\n`;

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: 'カジュアル',
      text: 'カジュアル',
    },
    {
      type: 'message',
      label: '丁寧',
      text: '丁寧',
    },
    {
      type: 'message',
      label: 'ビジネス',
      text: 'ビジネス',
    },
    {
      type: 'message',
      label: 'この英文で良い',
      text: 'この英文で良い',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text: header + english,
    quickReply,
  });
}

async function handleAcceptSentence(lineUserId, replyToken) {
  const ctx = userContext.get(lineUserId);
  if (!ctx || !ctx.lastCandidate) {
    const quickReply = buildQuickReply([]);
    return client.replyMessage(replyToken, {
      type: 'text',
      text: '直近の英文が見つかりません。もう一度文章を送ってください。',
      quickReply,
    });
  }

  const settings = await getOrCreateUserSettings(lineUserId);

  // 1通目: コピペ用の英文のみ
  const copyMessage = {
    type: 'text',
    text: ctx.lastCandidate,
    quickReply: buildQuickReply([]),
  };

  // 2通目: ワンポイントレッスン
  const onePointPrompt = buildOnePointPrompt(settings, ctx.lastCandidate);
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: onePointPrompt },
      { role: 'user', content: 'ワンポイントレッスンを出してください。' },
    ],
  });

  const lessonText = (completion.choices[0].message.content || '').trim();

  const lessonMessage = {
    type: 'text',
    text: `ワンポイントレッスン\n------------------------------\n${lessonText}`,
    quickReply: buildQuickReply([]),
  };

  return client.replyMessage(replyToken, [copyMessage, lessonMessage]);
}

// -----------------------
// 使い方ヘルプ
// -----------------------
async function replyHelp(replyToken) {
  const text =
    'YourTranslator 使い方\n\n' +
    '1. まず「ホーム」→「レベルを変更」「英語タイプ変更」「文体を変更」で初期設定してください。\n' +
    '2. その後、日本語または英語の文章を送ると、設定に合わせて英語に翻訳・リライトします。\n' +
    '3. 出てきた英文に対して、クイックメニューで「カジュアル」「丁寧」「ビジネス」を選ぶと、' +
    '同じ内容を別の文体で作り直します。\n' +
    '4. 「この英文で良い」を押すと、コピペ用の英文だけを返し、その後にワンポイントレッスンが届きます。';

  const quickReply = buildQuickReply([
    {
      type: 'message',
      label: 'ホーム',
      text: 'ホーム',
    },
  ]);

  return client.replyMessage(replyToken, {
    type: 'text',
    text,
    quickReply,
  });
}

// -----------------------
// メインイベントハンドラ
// -----------------------
async function handleEvent(event) {
  const lineUserId = event.source && event.source.userId;

  if (!lineUserId) {
    return;
  }

  if (event.type === 'follow') {
    const settings = await getOrCreateUserSettings(lineUserId);
    const text =
      'YourTranslator です。\n\n' +
      'まずは「ホーム」からレベルや文体を設定してみてください。\n' +
      'その後、日本語または英語の文章を送ると、あなたの設定に合わせて英語にして返します。';

    const quickReply = buildQuickReply([
      {
        type: 'message',
        label: 'ホーム',
        text: 'ホーム',
      },
    ]);

    return client.replyMessage(event.replyToken, {
      type: 'text',
      text,
      quickReply,
    });
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();

    // --- ホーム・設定 ---
    if (text === 'ホーム' || text === 'メニュー') {
      const settings = await getOrCreateUserSettings(lineUserId);
      return replyHomeMenu(event.replyToken, settings);
    }

    if (text === '設定') {
      const settings = await getOrCreateUserSettings(lineUserId);
      return replyHomeMenu(event.replyToken, settings);
    }

    if (text === '使い方') {
      return replyHelp(event.replyToken);
    }

    // --- 設定メニュー ---
    if (text === '[設定] レベル') {
      return replyLevelMenu(event.replyToken);
    }

    if (text === '[設定] 英検レベル') {
      return replyEikenMenu(event.replyToken);
    }

    if (text === '[設定] TOEICスコア') {
      return replyToeicMenu(event.replyToken);
    }

    if (text === '[設定] 文体') {
      const settings = await getOrCreateUserSettings(lineUserId);
      return replyToneMenu(event.replyToken, settings);
    }

    if (text === '[設定] 英語タイプ') {
      const settings = await getOrCreateUserSettings(lineUserId);
      return replyVariantMenu(event.replyToken, settings);
    }

    // --- レベル設定（英検） ---
    if (text.startsWith('SET_LEVEL_EIKEN_')) {
      const grade = text.replace('SET_LEVEL_EIKEN_', '');
      const settings = await updateUserSettings(lineUserId, {
        english_level_type: 'EIKEN',
        english_level_value: `EIKEN_${grade}`,
      });

      const msg =
        `レベルを「${describeLevel(settings)}」として登録しました。\n\n` +
        '日本語または英語の文章を送ると、そのレベルに合わせて英語に変換します。';

      const quickReply = buildQuickReply([
        {
          type: 'message',
          label: 'ホーム',
          text: 'ホーム',
        },
      ]);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    // --- レベル設定（TOEIC） ---
    if (text.startsWith('SET_LEVEL_TOEIC_')) {
      const range = text.replace('SET_LEVEL_TOEIC_', '');
      const settings = await updateUserSettings(lineUserId, {
        english_level_type: 'TOEIC',
        english_level_value: `TOEIC_${range}`,
      });

      const msg =
        `レベルを「${describeLevel(settings)}」として登録しました。\n\n` +
        '日本語または英語の文章を送ると、そのレベルに合わせて英語に変換します。';

      const quickReply = buildQuickReply([
        {
          type: 'message',
          label: 'ホーム',
          text: 'ホーム',
        },
      ]);

      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    // --- 文体設定 ---
    if (text === 'SET_TONE_CASUAL') {
      const settings = await updateUserSettings(lineUserId, {
        english_style_default: 'CASUAL',
      });
      const msg = `デフォルトの文体を「${describeTone(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    if (text === 'SET_TONE_POLITE') {
      const settings = await updateUserSettings(lineUserId, {
        english_style_default: 'POLITE',
      });
      const msg = `デフォルトの文体を「${describeTone(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    if (text === 'SET_TONE_BUSINESS') {
      const settings = await updateUserSettings(lineUserId, {
        english_style_default: 'BUSINESS',
      });
      const msg = `デフォルトの文体を「${describeTone(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    // --- 英語タイプ設定 ---
    if (text === 'SET_VARIANT_JP') {
      const settings = await updateUserSettings(lineUserId, {
        english_variant: 'JP',
      });
      const msg = `英語タイプを「${describeVariant(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    if (text === 'SET_VARIANT_US') {
      const settings = await updateUserSettings(lineUserId, {
        english_variant: 'US',
      });
      const msg = `英語タイプを「${describeVariant(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    if (text === 'SET_VARIANT_UK') {
      const settings = await updateUserSettings(lineUserId, {
        english_variant: 'UK',
      });
      const msg = `英語タイプを「${describeVariant(settings)}」に変更しました。`;

      const quickReply = buildQuickReply([]);
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: msg,
        quickReply,
      });
    }

    // --- 再トーン ---
    if (text === 'カジュアル' || text === '丁寧' || text === 'ビジネス') {
      return handleRetone(lineUserId, event.replyToken, text);
    }

    // --- この英文で良い ---
    if (text === 'この英文で良い') {
      return handleAcceptSentence(lineUserId, event.replyToken);
    }

    // --- 上記どれでもない = 翻訳・リライト本体 ---
    return handleTranslate(lineUserId, event.replyToken, text);
  }

  // 他のイベントタイプは無視
}

// -----------------------
// Express + LINE middleware
// -----------------------
app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body.events || [];

  // 先に 200 を返す → タイムアウト対策
  res.sendStatus(200);

  events.forEach((event) => {
    handleEvent(event).catch((err) => {
      console.error('handleEvent error:', err);
    });
  });
});

app.get('/', (req, res) => {
  res.send('YourTranslator bot is running.');
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log('LINE Token:', process.env.LINE_CHANNEL_ACCESS_TOKEN ? 'OK' : 'Missing');
  console.log('LINE Secret:', process.env.LINE_CHANNEL_SECRET ? 'OK' : 'Missing');
});
