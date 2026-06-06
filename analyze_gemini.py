import requests
import json
import time
import os

API_KEY = "AIzaSyDkboQNcUg3fPJ5JmSRF8Mu8-nyBoTMo3o"
AUDIO_PATH = r"C:\Users\g_n-n\Downloads\Telegram Desktop\Manish Bhaiya-2606010916.mp3"
MODEL = "gemini-3.5-flash"

# Step 1: Upload audio via Files API
print("Uploading audio to Gemini Files API...")
file_size = os.path.getsize(AUDIO_PATH)

# Initiate resumable upload
headers = {
    "X-Goog-Upload-Protocol": "resumable",
    "X-Goog-Upload-Command": "start",
    "X-Goog-Upload-Header-Content-Length": str(file_size),
    "X-Goog-Upload-Header-Content-Type": "audio/mpeg",
    "Content-Type": "application/json"
}
init_resp = requests.post(
    f"https://generativelanguage.googleapis.com/upload/v1beta/files?key={API_KEY}",
    headers=headers,
    json={"file": {"display_name": "manish-audio.mp3"}}
)
init_resp.raise_for_status()
upload_url = init_resp.headers.get("X-Goog-Upload-URL")
print(f"Upload URL obtained.")

# Upload the file
with open(AUDIO_PATH, "rb") as f:
    audio_data = f.read()

upload_resp = requests.post(
    upload_url,
    headers={
        "Content-Length": str(file_size),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize"
    },
    data=audio_data
)
upload_resp.raise_for_status()
file_uri = upload_resp.json()["file"]["uri"]
file_name = upload_resp.json()["file"]["name"]
print(f"File uploaded: {file_uri}")

# Wait for file to be processed
print("Waiting for file to be processed...")
while True:
    status_resp = requests.get(
        f"https://generativelanguage.googleapis.com/v1beta/{file_name}?key={API_KEY}"
    )
    state = status_resp.json().get("state", "")
    if state == "ACTIVE":
        print("File ready!")
        break
    elif state == "FAILED":
        print("File processing failed!")
        exit(1)
    else:
        print(f"  State: {state}...")
        time.sleep(2)

# Step 2: Transcribe + Analyze with Gemini
print(f"\nAsking {MODEL} to transcribe and analyze...")

prompt = """This is a Hindi phone call audio (~15 minutes). Please:

1. Give a FULL verbatim transcript in Hindi with timestamps in this format:
[MM:SS - MM:SS] - <spoken text>
Group 3-7 words per segment.

2. After the full transcript, provide a detailed analysis in English:
   - Who are the speakers (Speaker A, Speaker B etc.)
   - Main topics discussed
   - Key decisions made
   - Action items mentioned
   - Overall purpose/intent of the conversation
   - Any notable names, channels, or references mentioned

Be thorough and accurate. For the transcript, preserve the Hindi text exactly as spoken."""

payload = {
    "contents": [{
        "parts": [
            {
                "file_data": {
                    "mime_type": "audio/mpeg",
                    "file_uri": file_uri
                }
            },
            {
                "text": prompt
            }
        ]
    }],
    "generationConfig": {
        "temperature": 0.1,
        "maxOutputTokens": 65536
    }
}

resp = requests.post(
    f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={API_KEY}",
    json=payload,
    timeout=300
)
resp.raise_for_status()

result = resp.json()
text = result["candidates"][0]["content"]["parts"][0]["text"]

# Save output
with open("transcript_gemini.txt", "w", encoding="utf-8") as f:
    f.write(f"Model: {MODEL}\n")
    f.write("="*60 + "\n\n")
    f.write(text)

print("\n" + "="*60)
print(text)
print("="*60)
print("\nSaved to transcript_gemini.txt")
