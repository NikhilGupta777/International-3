/**
 * Patches timestamps.ts:
 * 1. Replaces SYSTEM_PROMPT with a detailed one (endSec schema, Pune Sabha examples, more density)
 * 2. Updates TimestampEntry to include optional endSec
 * 3. Fixes YouTube chapter short-circuit → passes chapters as hints to Gemini
 * 4. Updates callGemini user content to ask for endSec + detail
 */
import { readFileSync, writeFileSync } from "fs";

const file = "artifacts/api-server/src/routes/timestamps.ts";
let src = readFileSync(file, "utf8");
let changes = 0;

// ── 1. Replace SYSTEM_PROMPT ──────────────────────────────────────────────────
const OLD_PROMPT_START = "const SYSTEM_PROMPT = `You are an expert YouTube chapter creator for spiritual discourse";
const OLD_PROMPT_END   = `[{\"startSec\":0,\"label\":\"Mantraucharan aur Aarti\"},{\"startSec\":1106,\"label\":\"Bhajan \u2014 Govind Bolo Hari Gopal Bolo\"},{\"startSec\":1572,\"label\":\"Manav Jeevan ka Lakshya aur Bhagwat Mahapuran ka Mahatva\"},{\"startSec\":2548,\"label\":\"Hare Ram Hare Krishna Mahamantra\"},{\"startSec\":3167,\"label\":\"Bhajan \u2014 Madhav Madhav aur Kalki Mahamantra\"},{\"startSec\":3690,\"label\":\"Satsang ka Manav Jeevan mein Mahatva\"},{\"startSec\":4270,\"label\":\"Kaliyug ke Logo ka Udhar aur Bhagwat Mahapuran\"},{\"startSec\":4750,\"label\":\"Aarti Kunj Bihari Ki\"},{\"startSec\":5162,\"label\":\"Bhagwat Mahapuran ka Tatva \u2014 Bhagwat Katha\"},{\"startSec\":6104,\"label\":\"Geet Govind\"}]}\``;

// Find actual end of the prompt string (ends with backtick on its own line after the examples)
const promptStart = src.indexOf(OLD_PROMPT_START);
if (promptStart === -1) { console.error("❌ Could not find SYSTEM_PROMPT start"); process.exit(1); }

// Find the closing backtick of the template literal (the one after the last example)
let promptEnd = -1;
// Walk from promptStart forward; find the closing backtick of the template literal
// It appears as `;\n` or `;\r\n` after the last JSON example on a line by itself
let pos = promptStart + 100;
while (pos < src.length) {
  if (src[pos] === '`' && src[pos+1] === ';') { promptEnd = pos + 2; break; }
  pos++;
}
if (promptEnd === -1) { console.error("❌ Could not find SYSTEM_PROMPT end"); process.exit(1); }

const NEW_PROMPT = `const SYSTEM_PROMPT = \`You are a Bhagwat Katha timestamp expert. You deeply understand spiritual discourses (pravachan), bhajans, mantra chanting, and devotional content in Hindi, Odia, Sanskrit, and English.

Your task: analyze the transcript and produce DETAILED, topic-level timestamps — one per distinct topic, story, bhajan, or mantra segment.

OUTPUT FORMAT: Return ONLY a valid JSON array. Each object must have:
  { "startSec": number, "endSec": number, "label": string }

CRITICAL RULES:
1. First entry MUST be startSec: 0.
2. TARGET DENSITY: aim for 1 timestamp every 4-8 minutes of content. A 2-hour video = 15-20+ entries. A 30-min video = 5-8 entries. Never give fewer than 5.
3. Each "endSec" = the startSec of the NEXT entry (last entry endSec = video duration in seconds).
4. Write labels in the SAME language as the video (Hindi for Hindi, Odia for Odia, etc.).
5. Bhajans/songs: "भजन — [first line or name of the song]"
6. Mantra chanting / aarti: "मंत्रोच्चारण / आरती"
7. Labels must be SPECIFIC and DESCRIPTIVE (10-60 chars). No generic "Part 1", "Introduction", "Conclusion".
8. Capture every distinct topic shift — scripture citation, prophecy, moral story, devotee anecdote, philosophical point, etc.
9. Return ONLY the JSON array — no explanation, no markdown fences.

REFERENCE EXAMPLE A — L4 Katha (~2 hr 7 min): "L4- कल्कि भगवान के साथ भेंट करने का मार्ग"
[{"startSec":0,"endSec":230,"label":"परिचय और आरंभिक मंत्रोच्चारण"},
{"startSec":230,"endSec":452,"label":"पंचसखाओं ने चारों युगों में जन्म लेकर कार्य किए और मालिका 600 साल पहले लिखी"},
{"startSec":452,"endSec":514,"label":"भविष्य मालिका में गोपी, तापी, कपी का कलयुग से सतयुग में प्रवेश"},
{"startSec":514,"endSec":605,"label":"चारों युगों के भक्त ही कल्कि भगवान को पहचानेंगे, अन्य कोई नहीं"},
{"startSec":605,"endSec":683,"label":"कल्कि भगवान भक्त को सपने में या मालिका द्वारा जन्म का संदेश देंगे"},
{"startSec":683,"endSec":1352,"label":"12000 भक्तों को लेकर भगवान कल्कि धर्म संस्थापना का कार्य करेंगे"},
{"startSec":1352,"endSec":1649,"label":"कलयुग अंत में शासक लोग जनता को लूटेंगे, सुखा पड़ेगा तब कल्कि अवतार"},
{"startSec":1649,"endSec":1854,"label":"रामायण में कलयुग अंत के संकेत — तुलसीदास, गरुण और काग भूशंडी संवाद"},
{"startSec":1854,"endSec":1944,"label":"कोष दल भक्त पहले आएंगे, बाद वालों की रक्षा भगवान के नाम से"},
{"startSec":1944,"endSec":2711,"label":"सुधर्मा सभा जाजपुर में जब बैठेगा, ब्रह्मा विष्णु महेश वहां आएंगे"},
{"startSec":2711,"endSec":2940,"label":"एक भक्त द्वारा देखा गया मां काली का स्वरूप"},
{"startSec":2940,"endSec":3060,"label":"माता योग माया रोग रूप में मनुष्य के शरीर में प्रवेश करेंगी"},
{"startSec":3060,"endSec":3217,"label":"कोलकाता शहर में भविष्य में कैसा विनाश होगा"},
{"startSec":3217,"endSec":3322,"label":"13 मुस्लिम देश कौन से हैं जो भारत पर आक्रमण करेंगे"},
{"startSec":3322,"endSec":3348,"label":"भारत के पक्ष में कौन से देश — अमेरिका विश्वासघात करेगा"},
{"startSec":3584,"endSec":3654,"label":"उड़ीसा में कल्कि भगवान 14 लाख म्लेच्छ सैनिकों का सुदर्शन चक्र से संहार"},
{"startSec":4044,"endSec":4096,"label":"कलि कौन है?"},
{"startSec":4901,"endSec":4943,"label":"भगवान कल्कि मानव शरीर में आएंगे"},
{"startSec":6494,"endSec":6560,"label":"माता काल भैरवी का आवास कब होगा?"},
{"startSec":6968,"endSec":7027,"label":"गुप्त संबल ग्राम कहां है?"}]

REFERENCE EXAMPLE B — Pune Sabha Day 4 (~2 hr): "PUNE SABHA DAY 4"
[{"startSec":0,"endSec":828,"label":"आरंभ और मंत्रोच्चारण"},
{"startSec":828,"endSec":1012,"label":"तप, दया और दान का अर्थ"},
{"startSec":1012,"endSec":1350,"label":"धन की कमी — अमीर गरीब सब एक समान हो जायेंगे"},
{"startSec":1350,"endSec":1685,"label":"भजन — गोविंद राधे माधव, गोपाल राधे माधव"},
{"startSec":1885,"endSec":1969,"label":"सनातनी कौन है?"},
{"startSec":1969,"endSec":2276,"label":"मत्स्य अवतार"},
{"startSec":2276,"endSec":2663,"label":"कच्छप अवतार"},
{"startSec":2663,"endSec":3244,"label":"भजन — मेरा छोड़ दे दुपट्टा नन्दलाल सवेरे दही लेके आयूंगी"},
{"startSec":3262,"endSec":3415,"label":"वराह अवतार"},
{"startSec":3415,"endSec":3674,"label":"दशावतार से अष्टादश पुराण का फल"},
{"startSec":4074,"endSec":4375,"label":"माधव नाम का अर्थ और महत्व"},
{"startSec":4433,"endSec":4682,"label":"माधव नाम से भूकंप और बाढ़ आदि से सुरक्षा"},
{"startSec":4768,"endSec":4834,"label":"माधव नाम से मिसाइल और बीमारियों से सुरक्षा"},
{"startSec":4841,"endSec":4978,"label":"नरसिंह अवतार"},
{"startSec":4990,"endSec":5265,"label":"वामन अवतार"},
{"startSec":5303,"endSec":6265,"label":"भजन — सांवली सूरत पे मोहन दिल दीवाना हो गया"},
{"startSec":6040,"endSec":6164,"label":"परशुराम अवतार"},
{"startSec":6353,"endSec":6604,"label":"भगवान कल्कि की परशुराम जी को गुरु दक्षिणा और हर युग में अस्त्र प्रदान"},
{"startSec":6608,"endSec":6910,"label":"राम अवतार"}]\`;
`;

src = src.slice(0, promptStart) + NEW_PROMPT + src.slice(promptEnd);
changes++;
console.log("✅ 1. SYSTEM_PROMPT replaced");

// ── 2. Update TimestampEntry interface to include optional endSec ──────────────
const OLD_IFACE = "export interface TimestampEntry { startSec: number; label: string; }";
const NEW_IFACE  = "export interface TimestampEntry { startSec: number; endSec?: number; label: string; }";
if (src.includes(OLD_IFACE)) {
  src = src.replace(OLD_IFACE, NEW_IFACE);
  changes++; console.log("✅ 2. TimestampEntry interface updated with endSec");
} else {
  console.warn("⚠️  TimestampEntry interface not found as expected — check manually");
}

// ── 3. Fix YouTube chapters short-circuit → pass as hints to Gemini ───────────
const OLD_CHAPTERS = `    // 1. Existing chapter markers
    if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
      const transcript = meta.chapters.map((c: any) => \`[\${formatTime(c.start_time)}] \${c.title}\`).join("\\n");
      return { transcript, source: "chapters" };
    }`;
const NEW_CHAPTERS = `    // 1. Existing chapter markers — pass as HINTS to Gemini rather than using directly.
    // YouTube auto-chapters are often too coarse (3-5 entries for a 2h katha).
    // We keep them as a hint prefix so Gemini can use them as anchor points and add detail.
    let chapterHints = "";
    if (Array.isArray(meta.chapters) && meta.chapters.length > 0) {
      chapterHints = "[EXISTING YOUTUBE CHAPTERS — use as timing hints only, generate more detailed entries]\\n"
        + meta.chapters.map((c: any) => \`[\${formatTime(c.start_time)}] \${c.title}\`).join("\\n") + "\\n\\n";
    }`;

// Normalize line endings for comparison
const srcNorm = src.replace(/\r\n/g, "\n");
const oldNorm  = OLD_CHAPTERS.replace(/\r\n/g, "\n");
if (srcNorm.includes(oldNorm)) {
  src = srcNorm.replace(oldNorm, NEW_CHAPTERS);
  changes++; console.log("✅ 3. Chapter short-circuit fixed — now passes hints to Gemini");
} else {
  console.warn("⚠️  Chapter block not found as expected — check manually");
}

// ── 4. Add chapterHints prefix to transcript returns ─────────────────────────
// After the VTT subtitle fetch succeeds, prepend chapterHints
src = src.replace(
  /if \(deduped\.length > 0\) return \{ transcript: cuesToText\(deduped\), source: "youtube" \};/g,
  'if (deduped.length > 0) return { transcript: chapterHints + cuesToText(deduped), source: "youtube" };'
);
// After AssemblyAI words
src = src.replace(
  /const transcript = assemblyAiWordsToText\(words\);\s*return \{ transcript, source: "assemblyai" \};/,
  'const transcript = chapterHints + assemblyAiWordsToText(words);\n        return { transcript, source: "assemblyai" };'
);
changes++; console.log("✅ 4. chapterHints prepended to all transcript paths");

// ── 5. Update callGemini user content to ask for endSec ─────────────────────
const OLD_USER_MSG = 'Generate YouTube chapter timestamps. Return ONLY the JSON array.`';
const NEW_USER_MSG = 'Generate detailed topic-level timestamps (1 per 4-8 min, 15-20+ for a 2h video). Include endSec for each entry. Return ONLY the JSON array.`';
if (src.includes(OLD_USER_MSG)) {
  src = src.replace(OLD_USER_MSG, NEW_USER_MSG);
  changes++; console.log("✅ 5. callGemini user message updated to request endSec + detail");
} else {
  console.warn("⚠️  Old callGemini user message not found");
}

writeFileSync(file, src, "utf8");
console.log(`\n✅ Done — ${changes} changes applied to ${file}`);
