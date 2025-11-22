require('dotenv').config();
const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
const { OpenAI } = require('openai');
const { createClient } = require('@supabase/supabase-js');

const app = express();

/**
 * ========= 環境変数チェック =========
 */
const requiredEnv = {
  LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
  OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
  SUPABASE_URL: !!process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
};

if (!Object.values(requiredEnv).every(Boolean)) {
  console.error('❌ 必須の環境変数が足りません', requiredEnv);
  process.exit(1);
}

/**
 * ========= クライアント初期化 =========
 */
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/**
 * ========= ユーザー関連ヘルパー =========
 * Supabase 側には yourtranslator 用の
 *   public.users (id, user_id, level_label, created_at, updated_at)
 * がある前提。
 */

async function getOrCreateUser(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    console.error('❌ getOrCreateUser: select エラー', error);
    throw error;
  }

  if (data) return data;

  const { data: inserted, error: insertError } = await supabase
    .from('users')
    .insert({ user_id: userId })
    .select('*')
    .single();

  if (insertError) {
    console.error('❌ getOrCreateUser: insert エラー', insertError);
    throw insertError;
  }

  return inserted;
}

async function updateUserLevel(userId, levelLabel) {
  const { data, error } = await supabase
    .from('users')
    .update({ level_label: levelLabel })
    .eq('user_id', userId)
    .select('*')
    .single();

  if (error) {
    console.error('❌ updateUserLevel エラー', error);
    throw error;
  }

  return data;
}

/**
 * ========= OpenAI で翻訳・リライト =========
 * - 日本語 -> レベルに合わせた英訳
 * - 英語 -> レベルに合わせた書き直し
 */

async function translateWithLevel(levelLabel, userText) {
  const systemPrompt = `
You are an English writing assistant for Japanese learners.
User's self-reported level: "${levelLabel}".

Rules:
- If the user message is in Japanese, OUTPUT ONLY natural English at that level.
- If the user message is already in English, rewrite it to match that level: clear, natural, and not too difficult.
- Do NOT add explanations or Japanese. Only output the final English sentence(s).
  `.trim();

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || '';
}

/**
 * ========= メインのイベント処理 =========
 */

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 友だち以外（不明）の場合ガード
  if (!userId) {
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ユーザーIDを取得できませんでした。',
    });
  }

  // 制御コマンド（ヘルプ・リセットなど）
  if (text === 'ヘルプ' || text.toLowerCase() === 'help') {
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text:
        'YourTranslator です。\n\n' +
        '① はじめに、あなたの英語レベルを日本語で教えてください。\n' +
        '   例）英検2級 / TOEIC600 / 中学英語レベル など\n' +
        '② 登録後は、日本語または英語の文章を送ると、\n' +
        '   あなたのレベルに合わせた英語に翻訳・リライトします。\n\n' +
        'レベルを変えたいときは「レベル変更」と送ってください。',
    });
  }

  if (text === 'レベル変更') {
    // level_label を NULL にして再登録モードへ
    await updateUserLevel(userId, null);
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text:
        '英語レベルをリセットしました。\n' +
        'あらためて、あなたの英語レベルを教えてください。\n' +
        '例）英検準1級 / TOEIC800 / 日常会話レベル など',
    });
  }

  // ユーザー取得 or 新規作成
  const user = await getOrCreateUser(userId);

  // まだレベル未設定 → 最初の1通目 or レベル変更直後
  if (!user.level_label) {
    const levelLabel = text; // そのまま保存する
    await updateUserLevel(userId, levelLabel);

    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text:
        `英語レベルを「${levelLabel}」として登録しました。\n\n` +
        'これからは、日本語または英語の文章を送ると、\n' +
        'あなたのレベルに合わせた英語に翻訳・リライトします。\n\n' +
        '使い方の例：\n' +
        '・「明日のミーティングをリスケしたいです。」\n' +
        '・「カジュアルにお願いしたいニュアンスで」\n' +
        '・英語の文を送って「もっと丁寧にして」など',
    });
  }

  // ここからが通常利用：翻訳 / リライト
  const levelLabel = user.level_label;

  try {
    const translated = await translateWithLevel(levelLabel, text);

    if (!translated) {
      return lineClient.replyMessage(event.replyToken, {
        type: 'text',
        text: '翻訳結果を取得できませんでした。少し時間をおいて再度お試しください。',
      });
    }

    // シンプルな2段構成：レベル表示 + 結果
    const replyText =
      `【レベル: ${levelLabel} に合わせた英語】\n` +
      '------------------------------\n' +
      translated;

    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: replyText,
    });
  } catch (err) {
    console.error('❌ translateWithLevel エラー', err);
    return lineClient.replyMessage(event.replyToken, {
      type: 'text',
      text: '翻訳中にエラーが発生しました。しばらくしてからもう一度お試しください。',
    });
  }
}

/**
 * ========= LINE Webhook =========
 */

app.post('/webhook', middleware(lineConfig), async (req, res) => {
  const events = req.body.events || [];
  console.log('📩 Webhook received:', events.length, 'events');

  const tasks = events.map(async (event) => {
    try {
      if (event.type === 'message' && event.message.type === 'text') {
        await handleTextMessage(event);
      } else {
        // それ以外は無視
        console.log('ℹ️ 未対応イベント type=', event.type);
      }
    } catch (err) {
      console.error('❌ イベント処理中エラー:', err);
      // replyToken は一度しか使えないので、ここでの再返信は控える
    }
  });

  await Promise.all(tasks);
  res.sendStatus(200);
});

/**
 * ========= 動作確認用エンドポイント =========
 */

app.get('/', (req, res) => {
  res.send('✅ YourTranslator bot is LIVE');
});

/**
 * ========= サーバ起動 =========
 */

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
