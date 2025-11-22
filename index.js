// index.js (Webhook 周りだけ抜粋)

const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
require('dotenv').config();

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// JSON ボディ
app.use(express.json());

// Webhook 受信
app.post('/webhook', middleware(config), (req, res) => {
  // ① 先に 200 を返すキューを積んでおく
  //   → イベントごとの処理は「非同期」で投げる
  const events = req.body.events || [];

  // 非同期で処理（awaitしない）
  Promise.all(
    events.map((event) => handleEvent(event).catch(err => {
      console.error('handleEvent error:', err);
    }))
  ).then(() => {
    // ここは実際にはすでに 200 返しててもOK
  });

  // ② HTTP レスポンスは即返す
  res.sendStatus(200);
});

// 実際のイベント処理
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }

  const userText = event.message.text;

  // ここで GPT 呼び出し & 翻訳 / 判定
  const replyText = await translateOrWhatever(userText, event);

  // LINE に返信（ここは webhook のレスポンスとは別の話）
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

// 例:GPT呼び出し部分
async function translateOrWhatever(userText, event) {
  // OpenAI 呼び出し
  // ここは今までどおり。ただし timeout は短めにしておく方が安全
  return `echo: ${userText}`;
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
