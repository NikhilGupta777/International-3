/**
 * Phase-1 test data for New Tab Studio projects.
 *
 * Writes the local file-store fallback directly so the shell can be exercised
 * without a runner. Seeds for both possible identities (password login and the
 * Google account) since the owner hash depends on how you signed in.
 *
 *   node scripts/seed-newtab-projects.mjs          # write test projects
 *   node scripts/seed-newtab-projects.mjs --clear  # remove them again
 */
import crypto from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";

const STORE = join(process.cwd(), "artifacts", "api-server", "newtab-projects.json");

function ownerHash(method, subject) {
  return crypto.createHash("sha256").update(`${method}|${subject.toLowerCase()}`).digest("hex").slice(0, 24);
}

const OWNERS = [
  ownerHash("password", process.env.WEBSITE_AUTH_USER || "kalki_avatar"),
  ownerHash("google", "guptanikhil2056@gmail.com"),
];

const now = Date.now();
const minutes = (n) => n * 60_000;

function clip(label, startSec, endSec, status, extra = {}) {
  return {
    clipId: `clip_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    label,
    sourceVideoId: extra.sourceVideoId ?? "seed-video",
    startSec,
    endSec,
    details: extra.details ?? [],
    status,
    progress: status === "ready" ? 100 : (extra.progress ?? 0),
    message: extra.message ?? "",
    error: extra.error ?? null,
    jobs: {},
    outputs: status === "ready" ? { videoKey: "seed/clip.mp4" } : {},
    createdAt: now - minutes(30),
    updatedAt: now - minutes(2),
  };
}

function brief(overrides = {}) {
  return {
    goal: "",
    clipStrategy: "exhaustive",
    editStyle: "",
    outputSpec: { aspectRatio: "original", burnCaptions: false },
    channelProfileId: null,
    channelName: null,
    context: "",
    ...overrides,
  };
}

function project(owner, index, data) {
  return {
    projectId: `ntp_${crypto.createHash("md5").update(`${owner}-${index}`).digest("hex")}`,
    owner,
    activity: [],
    sourceVideos: [],
    clips: [],
    createdAt: now - minutes(90),
    updatedAt: now - minutes(index * 7 + 1),
    startedAt: now - minutes(85),
    completedAt: null,
    error: null,
    chatSessionId: null,
    ...data,
  };
}

function buildForOwner(owner) {
  const source = (title, durationSec) => ({
    videoId: "seed-video",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title,
    durationSec,
    thumbnailUrl: null,
    addedAt: now - minutes(90),
  });

  return [
    project(owner, 1, {
      title: "L4 — कल्कि भगवान के साथ भेंट करने का मार्ग",
      lifecycle: "running",
      brief: brief({
        goal: "Give all clips from this katha, one per topic",
        editStyle: "Keep the full topic, no music, straight cut",
        outputSpec: { aspectRatio: "original", burnCaptions: true, captionLanguage: "hi" },
        channelName: "Malika Decoder",
        context: "Long-form katha channel. Viewers watch full topics, so do not cut to shorts. Labels stay in Hindi.",
      }),
      sourceVideos: [source("L4- कल्कि भगवान के साथ भेंट करने का मार्ग", 7620)],
      clips: [
        clip("परिचय और आरंभिक मंत्रोच्चारण", 0, 230, "ready", {
          details: ["Opening mantra chanting", "Welcome to the assembled devotees"],
        }),
        clip("पंचसखाओं ने चारों युगों में जन्म लेकर कार्य किए", 230, 452, "ready", {
          details: ["The five companions across the four yugas", "Malika written 600 years ago"],
        }),
        clip("भविष्य मालिका में गोपी, तापी, कपी का प्रवेश", 452, 514, "ready"),
        clip("चारों युगों के भक्त ही कल्कि भगवान को पहचानेंगे", 514, 605, "cutting", {
          progress: 42, message: "Cutting with ffmpeg",
        }),
        clip("कल्कि भगवान भक्त को सपने में संदेश देंगे", 605, 683, "queued"),
        clip("12000 भक्तों को लेकर धर्म संस्थापना का कार्य", 683, 1352, "queued"),
        clip("कलयुग अंत में शासक जनता को लूटेंगे", 1352, 1649, "queued"),
        clip("रामायण में कलयुग अंत के संकेत", 1649, 1854, "queued"),
      ],
      activity: [
        { at: now - minutes(88), stage: "created", level: "info", message: "Project created" },
        { at: now - minutes(86), stage: "captions", level: "info", message: "Captions fetched (hi) — 2,104 cues" },
        { at: now - minutes(84), stage: "discovery", level: "info", message: "Segmentation returned 8 topics" },
        { at: now - minutes(83), stage: "discovery", level: "info", message: "Verification pass adjusted 2 boundaries" },
        { at: now - minutes(12), stage: "clip", level: "info", message: "परिचय और आरंभिक मंत्रोच्चारण: ready" },
      ],
    }),

    project(owner, 2, {
      title: "Pune Sabha Day 4 — full topic breakdown",
      lifecycle: "running",
      completedAt: now - minutes(20),
      brief: brief({
        goal: "All topics from Pune Sabha day 4",
        editStyle: "Straight cuts on topic boundaries",
        outputSpec: { aspectRatio: "original", burnCaptions: false },
        channelName: "Malika Decoder",
      }),
      sourceVideos: [source("PUNE SABHA DAY 4", 7200)],
      clips: [
        clip("आरंभ और मंत्रोच्चारण", 0, 828, "ready"),
        clip("तप, दया और दान का अर्थ", 828, 1012, "ready"),
        clip("धन की कमी — अमीर गरीब सब एक समान", 1012, 1350, "ready"),
        clip("भजन — गोविंद राधे माधव", 1350, 1685, "ready"),
        clip("मत्स्य अवतार", 1969, 2276, "ready"),
      ],
      activity: [
        { at: now - minutes(120), stage: "created", level: "info", message: "Project created" },
        { at: now - minutes(20), stage: "clip", level: "info", message: "मत्स्य अवतार: ready" },
      ],
    }),

    project(owner, 3, {
      title: "Bhavishya Malika Q&A — shorts pass",
      lifecycle: "running",
      brief: brief({
        goal: "Vertical shorts from the Q&A section",
        clipStrategy: "explicit_ranges",
        editStyle: "9:16, burned Hindi captions, punchy in-point",
        outputSpec: { aspectRatio: "9:16", burnCaptions: true, captionLanguage: "hi" },
        channelName: "Malika Shorts",
        context: "Shorts channel. Hook must land in the first 2 seconds.",
      }),
      sourceVideos: [source("Bhavishya Malika Q&A Session", 4800)],
      clips: [
        clip("कलि कौन है?", 4044, 4096, "ready"),
        clip("भगवान कल्कि मानव शरीर में आएंगे", 4901, 4943, "needs_input", {
          message: "Two speakers overlap at the in-point — pick a start",
        }),
        clip("माता काल भैरवी का आवास कब होगा?", 6494, 6560, "failed", {
          error: "yt-dlp: fragment 3 not found after 4 attempts",
        }),
        clip("गुप्त संबल ग्राम कहां है?", 6968, 7027, "cancelled", { message: "Cancelled" }),
      ],
      activity: [
        { at: now - minutes(200), stage: "created", level: "info", message: "Project created" },
        { at: now - minutes(60), stage: "clip", level: "error", message: "माता काल भैरवी का आवास कब होगा?: failed — yt-dlp fragment error" },
        { at: now - minutes(58), stage: "clip", level: "warn", message: "गुप्त संबल ग्राम कहां है?: cancelled" },
      ],
    }),

    project(owner, 4, {
      title: "Katha 12 Jan — vertical shorts",
      lifecycle: "planning",
      startedAt: now - minutes(1),
      brief: brief({
        goal: "Find every teaching moment and make shorts",
        outputSpec: { aspectRatio: "9:16", burnCaptions: true, captionLanguage: "hi" },
        channelName: "Malika Shorts",
      }),
      sourceVideos: [source("Katha 12 January — Jajpur", 5400)],
      clips: [],
      activity: [
        { at: now - minutes(1), stage: "created", level: "info", message: "Project created" },
        { at: now - minutes(1), stage: "captions", level: "info", message: "Fetching captions…" },
      ],
    }),
  ];
}

const clear = process.argv.includes("--clear");
const records = clear ? [] : OWNERS.flatMap(buildForOwner);
writeFileSync(STORE, JSON.stringify(records, null, 2), "utf8");
console.log(`${clear ? "Cleared" : `Seeded ${records.length}`} projects → ${STORE}`);
if (!clear) console.log(`Owners: ${OWNERS.join(", ")}`);
