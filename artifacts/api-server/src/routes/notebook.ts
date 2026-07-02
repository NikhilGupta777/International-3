import { Router, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pino from "pino";
import MiniSearch from "minisearch";
import { setupSse, sseFlush } from "../lib/sse";
import { getGeminiApiKeyForAttempt, getPersonalKeysForCaller } from "../lib/gemini-client";

const router = Router();
const logger = pino({ name: "notebook-search" });

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// Resolve index path dynamically
let indexCachePath = "";
const possiblePaths = [
  path.join(process.cwd(), "bhavishya_index.json"),
  path.join(process.cwd(), "artifacts/api-server/bhavishya_index.json"),
  path.resolve(MODULE_DIR, "../../bhavishya_index.json"),
  path.resolve(MODULE_DIR, "../bhavishya_index.json")
];

for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    indexCachePath = p;
    break;
  }
}

let miniSearchInstance: MiniSearch | null = null;
let rawDocuments: Record<string, any> = {};

// Load and index the Q&A database on startup
try {
  logger.info(`Loading search index from: ${indexCachePath || 'NOT_FOUND'}`);
  if (indexCachePath && fs.existsSync(indexCachePath)) {
    const indexData = JSON.parse(fs.readFileSync(indexCachePath, "utf8"));
    rawDocuments = indexData.storedFields || {};

    miniSearchInstance = MiniSearch.loadJSON(JSON.stringify(indexData), {
      fields: ["Question", "Answer", "Title"],
      storeFields: ["Question", "Answer", "Date", "Title", "URL", "Timestamp"]
    });
    logger.info(`Database loaded. Indexed ${Object.keys(rawDocuments).length} Q&As.`);
  } else {
    logger.error("CRITICAL: bhavishya_index.json not found in search paths.");
  }
} catch (err: any) {
  logger.error(`Failed to load search index database: ${err.message}`);
}

// === Tool Implementations ===

function searchDatabase(query: string) {
  if (!miniSearchInstance) return { error: "Database index is not available." };

  logger.info(`[Tool Call] searchDatabase for query: "${query}"`);
  const results = miniSearchInstance.search(query, {
    boost: { Question: 2, Answer: 1 },
    prefix: true,
    fuzzy: 0.2,
    combineWith: "OR"
  });

  if (results.length === 0) {
    return { total_matches_found: 0, matching_records: "No matches found." };
  }

  const maxScore = results[0].score;
  const threshold = maxScore * 0.1;
  const filtered = results.filter(r => r.score >= threshold);
  const sliced = filtered.slice(0, 22);

  let matchingRecordsText = "";
  sliced.forEach((r, idx) => {
    matchingRecordsText += `RECORD ${idx + 1}:\n`;
    matchingRecordsText += `Title: ${r.Title || 'N/A'}\n`;
    matchingRecordsText += `Date: ${r.Date || 'N/A'}\n`;
    matchingRecordsText += `URL: ${r.URL || 'N/A'}\n`;
    matchingRecordsText += `Question: ${r.Question || 'N/A'}\n`;
    matchingRecordsText += `Answer: ${r.Answer || 'N/A'}\n\n`;
  });

  logger.info(`[Tool Call] Found ${filtered.length} matches, returning top ${sliced.length}.`);
  return {
    total_matches_found: filtered.length,
    matching_records: matchingRecordsText
  };
}

function getVideoQas(videoTitle: string) {
  logger.info(`[Tool Call] getVideoQas for title: "${videoTitle}"`);
  const results: any[] = [];
  const queryLower = videoTitle.toLowerCase();

  for (const id in rawDocuments) {
    const doc = rawDocuments[id];
    if (doc.Title && doc.Title.toLowerCase().includes(queryLower)) {
      results.push(doc);
    }
  }

  const sliced = results.slice(0, 22);

  let matchingRecordsText = "";
  sliced.forEach((r, idx) => {
    matchingRecordsText += `RECORD ${idx + 1}:\n`;
    matchingRecordsText += `Title: ${r.Title || 'N/A'}\n`;
    matchingRecordsText += `Date: ${r.Date || 'N/A'}\n`;
    matchingRecordsText += `URL: ${r.URL || 'N/A'}\n`;
    matchingRecordsText += `Question: ${r.Question || 'N/A'}\n`;
    matchingRecordsText += `Answer: ${r.Answer || 'N/A'}\n\n`;
  });

  logger.info(`[Tool Call] Found ${results.length} matching Q&As, returning top ${sliced.length}.`);
  return {
    total_matches_found: results.length,
    matching_records: matchingRecordsText
  };
}

function getDatabaseStats() {
  logger.info(`[Tool Call] getDatabaseStats`);
  const totalDocs = Object.keys(rawDocuments).length;
  const uniqueVideos = new Set<string>();
  let minDate: string | null = null;
  let maxDate: string | null = null;
  let totalWords = 0;
  let totalCharacters = 0;

  for (const id in rawDocuments) {
    const doc = rawDocuments[id];
    const q = doc.Question || "";
    const a = doc.Answer || "";
    const combined = `${q} ${a}`;

    totalCharacters += combined.length;
    totalWords += combined.split(/\s+/).filter(w => w.length > 0).length;

    if (doc.URL) {
      let videoId = "";
      const urlStr = doc.URL;
      if (urlStr.includes("youtube.com/watch")) {
        const query = urlStr.split("?")[1] || "";
        const params = query.split("&");
        const vParam = params.find((p: string) => p.startsWith("v="));
        if (vParam) {
          videoId = vParam.split("=")[1];
        }
      } else if (urlStr.includes("youtu.be/")) {
        const parts = urlStr.split("youtu.be/");
        const pathPart = parts[1] || "";
        videoId = pathPart.split("?")[0].split("&")[0];
      }

      if (videoId) {
        uniqueVideos.add(`https://www.youtube.com/watch?v=${videoId}`);
      } else {
        uniqueVideos.add(urlStr.split('?')[0]);
      }
    }
    if (doc.Date && doc.Date !== 'N/A') {
      if (!minDate || doc.Date < minDate) minDate = doc.Date;
      if (!maxDate || doc.Date > maxDate) maxDate = doc.Date;
    }
  }

  return {
    total_qa_items: totalDocs,
    total_unique_videos: uniqueVideos.size,
    total_words: totalWords,
    total_characters: totalCharacters,
    date_range: { start: minDate || 'N/A', end: maxDate || 'N/A' }
  };
}

async function executeTool(name: string, args: any) {
  try {
    if (name === 'search_database') {
      return searchDatabase(args.query);
    } else if (name === 'get_video_qas') {
      return getVideoQas(args.video_title);
    } else if (name === 'get_database_stats') {
      return getDatabaseStats();
    } else {
      return { error: `Tool ${name} not found.` };
    }
  } catch (err: any) {
    return { error: `Execution error in ${name}: ${err.message}` };
  }
}

// Safeguard compactor logic to maintain user/model role alternation
function compactHistory(contents: any[], maxTokensEstimate = 180000) {
  let totalChars = 0;
  contents.forEach(msg => {
    msg.parts.forEach((p: any) => {
      if (p.text) totalChars += p.text.length;
    });
  });

  const estimatedTokens = totalChars / 4;
  if (estimatedTokens < maxTokensEstimate) {
    return contents;
  }

  logger.info(`[Compactor] History size (${Math.round(estimatedTokens)} tokens) exceeds threshold. Compacting...`);
  if (contents.length <= 3) return contents;

  const untouchedCount = 3;
  const historyToCompact = contents.slice(0, contents.length - untouchedCount);
  const untouchedHistory = contents.slice(contents.length - untouchedCount);

  const compacted: any[] = [];
  historyToCompact.forEach(msg => {
    if (msg.role === 'user') {
      const cleanParts = msg.parts.filter((p: any) => p.text && !p.functionResponse);
      if (cleanParts.length > 0) {
        compacted.push({ role: 'user', parts: cleanParts });
      }
    } else if (msg.role === 'model') {
      const cleanParts = msg.parts.filter((p: any) => p.text && !p.functionCall && !p.thought);
      if (cleanParts.length > 0) {
        compacted.push({ role: 'model', parts: cleanParts });
      }
    }
  });

  const combined = [...compacted, ...untouchedHistory];
  const finalContents: any[] = [];
  combined.forEach(msg => {
    if (!msg.parts || msg.parts.length === 0) return;

    if (finalContents.length === 0) {
      finalContents.push(JSON.parse(JSON.stringify(msg)));
    } else {
      const lastMsg = finalContents[finalContents.length - 1];
      if (lastMsg.role === msg.role) {
        lastMsg.parts = lastMsg.parts.concat(JSON.parse(JSON.stringify(msg.parts)));
      } else {
        finalContents.push(JSON.parse(JSON.stringify(msg)));
      }
    }
  });

  return finalContents;
}

const systemInstruction = {
  parts: [
    {
      text: `You are an agentic search assistant for the Bhavishya Malika Q&A database.
Your goal is to answer queries by scanning the database using the tools provided.

DATABASE PRIOR CONTEXT (Top 20 Videos & Themes):
Here is a compact directory of the top videos in the database. Use this prior knowledge of topics, video codes, and dates to plan your database search terms and target specific videos:

[Video 1] Title: "L110 - यशवंत दास मालिका में कल्कि जी के  जन्म नाभि मंडल, जाजनग्र में होगा | पण्डित काशीनाथ मिश्र जी" | Date: 2023-10-13\n  Topics: I have two questions. First, I don't eat non-vegetarian food, but sometimes we visit relatives where it is cooked. Can we eat the ...\n\n[Video 2] Title: "L44 नीम के पेड़ से निरंतर दूध निकलना, कलियुग अंत की प्रमुख सूचना.-- LIVE" | Date: 2022-02-03\n  Topics: I am asking, will the 51 Shakti Peeths survive this apocalyptic period? The 51 Shakti Peeths and the four Dhams (sacred abodes)?, ...\n\n[Video 3] Title: "L37 मृत्यु से विजय का रास्ता क्या है-- LIVE" | Date: 2022-01-06\n  Topics: I am Navjyoti Das from Assam. The day before yesterday, at 5 AM, I had a dream. I saw such a powerful storm that only the building...\n\n[Video 4] Title: "L109 - ''कलि आगत भविष्यांत'' में कल्कि जी के जन्म स्थान का वर्णन | पण्डित काशीनाथ मिश्र जी" | Date: 2023-10-11\n  Topics: I am not able to remember the Tri-Sandhya prayers. Even if I remember them, I forget. I feel very scared to start anything. It's b...\n\n[Video 5] Title: "L122 - त्रिकाल संध्या का तत्त्व | पण्डित श्री काशीनाथ मिश्र जी" | Date: 2024-03-04\n  Topics: After the Chandigarh assembly, there are assemblies in Bangalore and Toronto. Is this the last assembly? Will there be more after ...\n\n[Video 6] Title: "L130 - ईरान और यूक्रेन में युद्ध रुकेगा या तीव्र होगा? | पंडित काशीनाथ मिश्रा" | Date: 2024-04-28\n  Topics: Pandit ji, I am Abhishek from Bareilly. When I meditate, I see my elder brother who committed suicide in 2017. He appears in my dr...\n\n[Video 7] Title: "L4 कल्कि भगवान के साथ भेट करने का मार्ग, LIVE by pandit kashinath Mishra" | Date: 2021-06-19\n  Topics: What is God's form like?, Pandit ji, this is Ram Kumar Sharma. I have quit eating non-vegetarian food. Could you please guide my w...\n\n[Video 8] Title: "L175: धर्म एकमात्र रास्ता है | अभी भी समय है मानव सभ्यता के लिए | पंडित काशीनाथ मिश्र" | Date: 2025-03-26\n  Topics: Why is the Bhavishya Malika being propagated?, Why was this called a secret matter?, What is the goal of Bhavishya Malika?, And wh...\n\n[Video 9] Title: "L121 - तृतीय विश्व युद्ध की तैयारी | पण्डित श्री काशीनाथ मिश्र जी" | Date: 2024-03-03\n  Topics: Pandit ji, in which year is the India-Pakistan war certain to happen?, Yes, Pandit ji, I was saying that it was wonderful that you...\n\n[Video 10] Title: "L139: क्या भगवान कल्कि की लीला शुरू हो चुकी है ? | पंडित काशीनाथ मिश्र" | Date: 2024-06-06\n  Topics: Jai Shri Madhav, Father. I needed your blessings., The Lord's divine play, his secret play, is ongoing. Can human beings understan...\n\n[Video 11] Title: "L132: ज्यादा धूप और सऊदी में बारिश का कारण क्या है? | पंडित काशीनाथ मिश्र" | Date: 2024-05-05\n  Topics: Why is this climate change happening?, I wanted to ask... my father is having an angiography. Please ask everyone here to pray for...\n\n[Video 12] Title: "L16.1 सुधर्मा महा महासंघ के आभिमुख्य और विश्व सनातन धर्म की प्रतिष्ठा" | Date: 2021-08-29\n  Topics: You had mentioned that Muslim countries will unite to fight and bombs will explode. Is what is happening now in Kabul, Afghanistan...\n\n[Video 13] Title: "L17 भक्तों का एकत्रीकरण कहां होगा? और कल्कि भगवान के साथ कैसे भेट होगा?" | Date: 2021-09-05\n  Topics: How will the connection between the devotee and God be established? How will devotees connect with God? And the biggest question i...\n\n[Video 14] Title: "L9 विश्व के सभी भक्तों के बारे में (पद्म कल्प टीका ग्रंथ) भविष्य मालिका में वर्णन है।" | Date: 2021-07-11\n  Topics: So the question is, where is this secret scripture?, Where has that scripture been kept?, I had a Satyanarayan Katha (a ritual pra...\n\n[Video 15] Title: "L25 वर्तमान के समय में बच्चे लोग को पिता-माता को क्या शिक्षा प्रदान करना जरूरी है?  LIVE" | Date: 2021-11-14\n  Topics: What is the significance of the devastating rains we are seeing in Chennai and other parts of South India?, Panditji, I wanted to ...\n\n[Video 16] Title: "L112 - बलराम दास मालिका में कल्कि जी के जन्मस्थान का प्रमाण | पण्डित काशीनाथ मिश्र जी" | Date: 2023-10-15\n  Topics: A few years ago, my elder brother and his wife passed away. We have been facing constant problems in the house ever since. What sh...\n\n[Video 17] Title: "L114 - एकाम्र वन खंडगिरि में कल्कि लीला का प्रकाश होगा | पण्डित काशीनाथ मिश्र जी" | Date: 2023-10-16\n  Topics: Guruji, I am from a village in Uttar Pradesh. I urinated near a Peepal (sacred fig) tree without realizing it at first. Since retu...\n\n[Video 18] Title: "L134: आगे उत्तर मेरु में बर्फीला प्रलय होगा | पंडित काशीनाथ मिश्र" | Date: 2024-05-13\n  Topics: Guruji, I have been married twice, and now I am doing my post-graduation. I wanted to know about my future., I wanted to ask, you ...\n\n[Video 19] Title: "L119 - विश्व के लिए 2024 कैसा होगा? | पण्डित श्री काशीनाथ मिश्र जी" | Date: 2024-01-02\n  Topics: I have a question and a request. The question is, for the past week, a new COVID JN variant has emerged with over 4,000 cases. Will...\n\n[Video 20] Title: "L32 सत्य में रहने वाले भक्तो को निंदा-अपमान मिलेगा-- विष्णु भगवान संहार के लिए कल्कि रूप धारण करेंगे" | Date: 2021-12-19\n  Topics: Pandit ji, I had a dream a few days ago that I was walking on a mountain, and there were many snakes lying on the path. They weren...\n\n

Search Strategy Rules:
1. Thorough Multi-Search: Do NOT rely on just a single search query. To ensure you find ALL matching videos, you MUST perform 2 to 3 distinct search queries using different methods, synonyms, and related terms (e.g. if the user asks about 'USA flood', query 'usa flood', 'America cataclysm', and 'western disasters' in parallel or sequential turns).
2. Bilingual Query Generation (Crucial for Hindi Transcripts): Since the database contains original Q&A records in English and new raw transcript records in Hindi (Devanagari script), you MUST search in BOTH English and Hindi. For any query, translate the key search terms into Hindi (Devanagari) and run search queries in both English and Hindi. For example, if searching for "Delhi earthquake", you should query "Delhi earthquake" in English, and "दिल्ली भूकंप" or "दिल्ली भूकंप मालिका" in Hindi (Devanagari) in parallel.
3. Execute searches in parallel in a single turn if possible, or execute them in subsequent turns if you need to refine the queries.
4. Merge and consolidate the search results, removing any duplicate Q&A records.
5. Once you have complete coverage, proceed to generate the final response.

Response formatting (CRITICAL RULES):
For every prompt that you receive to find a particular topic, search all the videos/sources given to you, find that topic in all video transcripts, and format your output strictly as follows:

User Request: "[Exactly what the user requested]"

Occourances: [N] Videos/Live Streams

### Video_1
Title: [Exact title of the video]

Link: [Clickable YouTube link with start time parameter appended. Convert the Start Time into total seconds and append as &t=Xs, e.g. 01:56:48 becomes &t=7008s, and 00:49 becomes &t=49s. Format example: https://www.youtube.com/watch?v=sB_L2bOrS7k&t=7008s]

Time: [Start Time] - [End Time] (Format example: 01:56:48 - 01:57:25 or 00:49 - 01:08. If the user asks for a clip, provide the best 8-12 minutes clip timing covering the topic)

Details: [Provide a list of exactly 2 to 4 bullet points. Out of these, you MUST include 1 to 2 bullet points displaying the exact text/statement spoken in the video transcript that matches the search query. Add inline bracketed timestamp tags like [116:48].]

### Video_2
Title: [Title]

Link: [Clickable YouTube link with start time parameter appended as &t=Xs, e.g. https://www.youtube.com/watch?v=qeIxccLEC9w&t=49s]

Time: [Start Time] - [End Time]

Details: [Exactly 2 to 4 bullet points, including 1 to 2 bullets with the exact statement spoken in the video matching the query.]

FORMATTING CONSTRAINTS:
- Do NOT merge everything into one paragraph.
- Title, Link, Time, and Details must ALWAYS be on separate lines and must be present.
- Add a blank line after each of these items to keep the format clean.
- Do not add extra commentary or explanations outside of this format.`
    }
  ]
};

router.get("/notebook/health", (_req: Request, res: Response) => {
  try {
    const stats = getDatabaseStats();
    res.json({
      enabled: true,
      configured: true,
      stats
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/notebook/ask/stream", async (req: Request, res: Response) => {
  setupSse(res);
  const rawMessage = typeof req.body?.message === "string" ? req.body.message : "";
  const requestMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];

  const messagesList = [...requestMessages];
  if (messagesList.length === 0 && rawMessage.trim()) {
    messagesList.push({ role: "user", content: rawMessage.trim() });
  }

  let closed = false;

  res.on("close", () => {
    closed = true;
  });

  const sendSseEvent = (type: string, data: any) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    sseFlush(res);
  };

  const modelName = process.env.GEMINI_MODEL || "gemma-4-31b-it";
  const geminiKeys = getPersonalKeysForCaller("find-video");

  if (geminiKeys.length === 0) {
    sendSseEvent("error", { message: "Gemini API key is not configured in the backend's .env file." });
    res.end();
    return;
  }

  if (messagesList.length === 0) {
    sendSseEvent("error", { message: "Enter a question first." });
    res.end();
    return;
  }

  try {
    const toolsConfig = [{
      functionDeclarations: [
        {
          name: "search_database",
          description: "Searches the Bhavishya Malika Q&A database for a query term. Returns relevant Q&As.",
          parameters: {
            type: "OBJECT",
            properties: {
              query: {
                type: "STRING",
                description: "The search query (e.g. 'usa flood' or 'sindoor')."
              }
            },
            required: ["query"]
          }
        },
        {
          name: "get_video_qas",
          description: "Returns all questions and answers associated with a specific video title.",
          parameters: {
            type: "OBJECT",
            properties: {
              video_title: {
                type: "STRING",
                description: "The title of the video."
              }
            },
            required: ["video_title"]
          }
        },
        {
          name: "get_database_stats",
          description: "Returns general stats about the Q&A database, such as total items, unique videos, and date range.",
          parameters: {
            type: "OBJECT",
            properties: {}
          }
        }
      ]
    }];

    // Format chat history for Gemini API
    let contents: any[] = [];
    messagesList.forEach((msg) => {
      const role = msg.role === "assistant" ? "model" : "user";
      contents.push({ role, parts: [{ text: msg.content }] });
    });

    const maxIterations = 5;
    let iteration = 0;
    let finalResponse: string | null = null;

    while (iteration < maxIterations) {
      if (closed) break;
      iteration++;
      logger.info(`[Agent Loop] Iteration ${iteration} for model ${modelName}`);
      sendSseEvent("thinking", { message: `Thinking (step ${iteration})...` });

      contents = compactHistory(contents);

      const requestBody = {
        contents,
        tools: toolsConfig,
        systemInstruction,
        generationConfig: {
          temperature: 0.2,
          topP: 0.95,
          topK: 64
        }
      };

      let response: any;
      let retries = 3;
      let delayMs = 1000;

      for (let attempt = 1; attempt <= retries; attempt++) {
        if (closed) break;
        const apiKey = getGeminiApiKeyForAttempt("find-video", attempt - 1);
        try {
          response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${apiKey}&alt=sse`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(requestBody)
            }
          );

          if (response.ok) {
            break;
          }

          const errorText = await response.text();
          logger.warn(`[Retry Warning] Attempt ${attempt} failed with status ${response.status}: ${errorText}`);
          if (attempt === retries) {
            throw new Error(`Gemini API returned error: ${response.status} - ${errorText}`);
          }
        } catch (fetchErr: any) {
          logger.error(`[Retry Error] Attempt ${attempt} threw: ${fetchErr.message}`);
          if (attempt === retries) {
            throw fetchErr;
          }
        }

        logger.info(`[Retry] Waiting ${delayMs}ms before attempt ${attempt + 1}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }

      if (closed || !response || !response.body) break;

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";

      let accumulatedParts: any[] = [];
      let currentFunctionCalls: any[] = [];
      let isThinking = false;

      while (true) {
        if (closed) break;
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value);
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;

          try {
            const chunk = JSON.parse(trimmed.substring(5).trim());
            const candidate = chunk.candidates?.[0];
            const content = candidate?.content;

            if (content && content.parts) {
              for (const part of content.parts) {
                let text = part.text || "";
                let isThoughtPart = (part.thought === true);

                if (isThoughtPart) {
                  if (text) {
                    sendSseEvent("thought_chunk", { content: text });
                  }
                } else if (text) {
                  // Fallback: parse inline thinking tags
                  if (text.includes('<think>') || text.includes('<|think|>')) {
                    isThinking = true;
                    text = text.replace('<think>', '').replace('<|think|>', '');
                  }

                  if (text.includes('</think>') || text.includes('</|think|>')) {
                    isThinking = false;
                    const parts = text.split(/<\/think>|<\/\|think\|>/);
                    if (parts[0]) sendSseEvent("thought_chunk", { content: parts[0] });
                    if (parts[1]) sendSseEvent("text_chunk", { content: parts[1] });
                  } else {
                    if (isThinking) {
                      sendSseEvent("thought_chunk", { content: text });
                    } else {
                      sendSseEvent("text_chunk", { content: text });
                    }
                  }
                }

                if (part.functionCall) {
                  currentFunctionCalls.push(part.functionCall);
                }

                accumulatedParts.push(part);
              }
            }
          } catch (e) {
            // parsing error or keep-alive tick, ignore
          }
        }
      }

      if (closed) break;

      // Group and combine the streamed parts to append to contents history
      const combinedParts: any[] = [];
      let currentTextPart: any = null;
      let currentThoughtPart: any = null;

      accumulatedParts.forEach(part => {
        if (part.thought === true) {
          if (currentThoughtPart) {
            currentThoughtPart.text += part.text;
          } else {
            currentThoughtPart = { thought: true, text: part.text };
            combinedParts.push(currentThoughtPart);
          }
          currentTextPart = null;
        } else if (part.text) {
          if (currentTextPart) {
            currentTextPart.text += part.text;
          } else {
            currentTextPart = { text: part.text };
            combinedParts.push(currentTextPart);
          }
          currentThoughtPart = null;
        } else if (part.functionCall) {
          combinedParts.push(part);
          currentTextPart = null;
          currentThoughtPart = null;
        }
      });

      contents.push({
        role: "model",
        parts: combinedParts
      });

      if (currentFunctionCalls.length > 0) {
        logger.info(`[Agent Loop] Model requested ${currentFunctionCalls.length} tool execution(s).`);

        const responseParts: any[] = [];
        for (const call of currentFunctionCalls) {
          const callName = call.name;
          const callArgs = call.args;

          let logMsg = "";
          if (callName === 'search_database') {
            logMsg = `🔍 Searching database for: "${callArgs.query}"`;
          } else if (callName === 'get_video_qas') {
            logMsg = `📺 Fetching Q&As for video: "${callArgs.video_title}"`;
          } else if (callName === 'get_database_stats') {
            logMsg = `📊 Retrieving database general stats`;
          }

          sendSseEvent("tool_start", { name: callName, message: logMsg });
          const result = await executeTool(callName, callArgs);

          let resultMsg = "";
          if (callName === 'search_database' || callName === 'get_video_qas') {
            const totalMatches = Number((result as { total_matches_found?: number }).total_matches_found ?? 0);
            const count = Math.min(22, totalMatches);
            resultMsg = `Found ${totalMatches} matches (sending top ${count} to Gemma)`;
          } else {
            resultMsg = `Stats loaded successfully.`;
          }

          sendSseEvent("tool_end", { name: callName, result: resultMsg });

          responseParts.push({
            functionResponse: {
              name: callName,
              response: result
            }
          });
        }

        contents.push({
          role: "user",
          parts: responseParts
        });
      } else {
        logger.info("[Agent Loop] Model returned final text answer.");
        let finalText = "";
        combinedParts.forEach(p => {
          if (p.text && !p.thought) finalText += p.text;
        });
        finalResponse = finalText;
        break;
      }
    }

    if (closed) return;

    if (iteration >= maxIterations && !finalResponse) {
      finalResponse = "Error: Too many function execution turns. The assistant timed out.";
    } else if (!finalResponse) {
      finalResponse = "No direct matching details found in the transcripts for this search query. Try rephrasing your question.";
    }

    sendSseEvent("final_result", { content: finalResponse });
    res.end();

  } catch (err: any) {
    logger.error(`API Error: ${err.message}`);
    sendSseEvent("error", { message: err.message });
    res.end();
  }
});

export default router;
