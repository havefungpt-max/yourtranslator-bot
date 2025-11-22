// index.js

require('dotenv').config();
const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `
You are the brain of a LINE bot called "YourTranslator" for Japanese users learning English.

Goal
- Given the latest user message and the saved user state, decide what the bot should do next.
- Always respond ONLY with a single JSON object. No extra text.

User input (from the app)
- message: the latest message from the user (Japanese or English).
- user_state: an object with:
  - english_level: free text like "EIKEN Grade 2", "TOEIC 600", "junior high school level".
  - english_flavor: "american", "british", or "jp-english".
  - last_english_output: the last English sentence the bot produced for this user, or "" if none.

Possible intents
- "register_profile": user is telling or changing their English level or preferred English flavor.
- "translate_or_rewrite": user sends Japanese or English content and wants a new English sentence.
- "modify_tone": user wants to change the tone (polite / business / casual etc.) of last_english_output.
- "show_help": user is asking how to use the bot.
- "other": anything else.

Tone handling
- Map user requests like:
  - "カジュアルに", "もっとカジュアルに" -> tone: "casual"
  - "丁寧に", "もっと丁寧に", "ビジネスっぽく" -> tone: "polite_business"
- For "modify_tone", never rewrite the Japanese command itself. Always apply the new tone to last_english_output.
- If tone is unclear, use null.

Registration handling
- Accept typos and noisy Japanese when detecting english_level and english_flavor.
- Normalize english_flavor to one of: "american", "british", "jp-english".
- If the user says things like "レベル変更", treat it as intent "register_profile" so the app can show a UI to change level.

Output JSON schema
Return exactly:

{
  "intent": "register_profile" | "translate_or_rewrite" | "modify_tone" | "show_help" | "other",
  "detected_english_level": string | null,
  "detected_english_flavor": "american" | "british" | "jp-english" | null,
  "tone": "casual" | "polite_business" | null,
  "should_reply_help": boolean,
  "analysis_comment": string
}

Rules
- analysis_comment is a short English explanation for developers (not shown to the end user).
- should_reply_help is true only when the bot should send a help message next.
- Never include any Japanese in the JSON values.
- Do not output anything except this single JSON object.
`;

/**
 * 判定用：ユーザメッセージ + ユーザ状態を投げて、意図JSONを返す
 */
async function analyzeUserMessage(userText, userState) {
  const userPayload = {
    message: userText,
    user_state: userState,
  };

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini', // or whatever you use
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices[0].message.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error('JSON parse error:', e, raw);
    // フォールバック：最低限 other を返す
    parsed = {
      intent: 'other',
      detected_english_level: null,
      detected_english_flavor: null,
      tone: null,
      should_reply_help: false,
      analysis_comment: 'Fallback because JSON parse failed.',
    };
  }
  return parsed;
}

// -------------- 以下は動作テスト用 --------------

// ダミーユーザ状態（実際はDBから取る）
const dummyState = {
  english_level: 'EIKEN 2',
  english_flavor: 'american',
  last_english_output: 'I would like to reschedule tomorrow\'s meeting.',
};

async function main() {
  const userText = 'もっと丁寧に'; // LINE から来たテキストをここに入れる想定

  const result = await analyzeUserMessage(userText, dummyState);
  console.log('Result JSON:', result);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  analyzeUserMessage,
};
