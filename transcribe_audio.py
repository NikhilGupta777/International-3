import requests
import time
import json
import sys

API_KEY = "7e70706faeea4b0d976389c493fa32b0"
HEADERS = {"authorization": API_KEY}
TRANSCRIPT_ID = "0c95cfc2-c0d0-4891-92dd-ee5920536abb"

# Fetch the already-completed transcript
print("Fetching transcript...")
resp = requests.get(
    f"https://api.assemblyai.com/v2/transcript/{TRANSCRIPT_ID}",
    headers=HEADERS
)
resp.raise_for_status()
data = resp.json()

words = data.get("words", [])
detected_lang = data.get("language_code", "unknown")

def format_time(ms):
    total_sec = ms / 1000
    minutes = int(total_sec // 60)
    seconds = total_sec % 60
    return f"{minutes:02d}:{seconds:05.2f}"

# Group words into segments of 3-7 words, breaking at natural pauses
segments = []
current_words = []
for i, w in enumerate(words):
    current_words.append(w)
    next_idx = i + 1 if i + 1 < len(words) else None
    gap = 0
    if next_idx is not None:
        gap = words[next_idx]["start"] - w["end"]

    should_break = (
        len(current_words) >= 7 or
        (len(current_words) >= 3 and gap > 400) or
        (len(current_words) >= 4 and gap > 200)
    )

    if should_break or i == len(words) - 1:
        seg_start = current_words[0]["start"]
        seg_end = current_words[-1]["end"]
        seg_text = " ".join(cw["text"] for cw in current_words)
        segments.append((seg_start, seg_end, seg_text))
        current_words = []

# Save transcript
output_lines = []
for start_ms, end_ms, text in segments:
    line = f"[{format_time(start_ms)} - {format_time(end_ms)}] - {text}"
    output_lines.append(line)

output = "\n".join(output_lines)

with open("transcript_manish.txt", "w", encoding="utf-8") as f:
    f.write(f"Language: {detected_lang}\n")
    f.write(f"Duration: {data.get('audio_duration', 0)}s\n")
    f.write(f"Total words: {len(words)}\n")
    f.write(f"Total segments: {len(segments)}\n\n")
    f.write(output)

# Save raw data
with open("transcript_manish_raw.json", "w", encoding="utf-8") as f:
    json.dump({
        "language": detected_lang,
        "duration": data.get("audio_duration", 0),
        "text": data.get("text", ""),
        "words": words,
        "segments": [(s, e, t) for s, e, t in segments]
    }, f, ensure_ascii=False, indent=2)

print(f"Done! Language: {detected_lang}, Duration: {data.get('audio_duration', 0)}s")
print(f"Words: {len(words)}, Segments: {len(segments)}")
print("Saved: transcript_manish.txt, transcript_manish_raw.json")
