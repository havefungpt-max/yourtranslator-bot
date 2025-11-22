const express = require('express');
const { middleware, Client } = require('@line/bot-sdk');
require('dotenv').config();

const app = express();

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(config);

// ✅ /webhook だけに LINE の middleware を適用
app.post('/webhook', middleware(config), (req, res) => {
  const events = req.body.events || [];

  // 非同期で処理を投げる
  Promise.all(
    events.map(event =>
      handleEvent(event).catch(err => console.error('handleEvent error:', err))
    )
  );

  // HTTP レスポンスは即 200
  res.sendStatus(200);
});

// 他のルートで JSON 使いたいなら、別で
app.use('/api', express.json());

app.get('/', (req, res) => {
  res.send('ok');
});

async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') return;

  const userText = event.message.text;

  // ここで GPT 叩くなど
  const replyText = `echo: ${userText}`;

  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
  console.log('Token:', process.env.LINE_CHANNEL_ACCESS_TOKEN ? 'OK' : 'Missing');
  console.log('Secret:', process.env.LINE_CHANNEL_SECRET ? 'OK' : 'Missing');
});
