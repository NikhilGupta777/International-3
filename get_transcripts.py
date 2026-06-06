import requests
import time
import sys
import io

# Fix stdout encoding for Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ASSEMBLYAI_KEY = "7e70706faeea4b0d976389c493fa32b0"
TRANSCRIPT_ID = "3c5e3845-209a-417d-b3e4-1a94ea07c6f1"

GEMINI_KEYS = [
    "AIzaSyDkboQNcUg3fPJ5JmSRF8Mu8-nyBoTMo3o",
    "AIzaSyCIBc2zjXic8YGHjZhMjxF9VPRcqVow7H8",
    "AIzaSyD7ImSAVy7XYpUEyNwn5XQwZH5FULNbFfw",
]

AUDIO_FILE = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\bhavishya malika puran (Manish Bhaiya)-2606061818.mp3"

GEMINI_PROMPT = """You are a professional transcription specialist. Your task is to produce a highly accurate, well-formatted transcript of the provided audio recording.

STRICT INSTRUCTIONS:
1. Transcribe EVERY word spoken — do not skip, summarize, or paraphrase anything.
2. This audio is in Hindi/Hinglish. Transcribe Hindi words in Devanagari script and English words in English.
3. Identify different speakers and label them as Speaker A, Speaker B, etc. (or use names if mentioned in the audio).
4. Include timestamps every 30 seconds in [MM:SS] format.
5. Format each speaker turn as a new line: [MM:SS] Speaker X: <text>
6. Mark unclear/inaudible words as [inaudible] and uncertain words with (word?).
7. Preserve natural speech including filler words like "um", "uh", "hmm", "haan", "acha", etc.
8. Do NOT add any commentary, notes, or summaries — only the raw transcript.
9. If music or non-speech sounds occur, note them as [music], [background noise], etc.

Begin the transcript now:"""

# ── 1. ASSEMBLYAI ──────────────────────────────────────────────
print("=" * 60)
print("STEP 1: Fetching AssemblyAI Transcript")
print("=" * 60)

headers = {"authorization": ASSEMBLYAI_KEY}
r = requests.get(f"https://api.assemblyai.com/v2/transcript/{TRANSCRIPT_ID}", headers=headers)
data = r.json()

duration_s = data.get('audio_duration', 0)
print(f"Status   : {data['status']}")
print(f"Language : {data.get('language_code', 'N/A')}")
print(f"Duration : {duration_s:.1f}s ({duration_s/60:.1f} min)")

assemblyai_out = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\assemblyai_transcript.txt"
with open(assemblyai_out, "w", encoding="utf-8") as f:
    f.write("=" * 60 + "\n")
    f.write("ASSEMBLYAI TRANSCRIPT\n")
    f.write(f"File    : bhavishya malika puran (Manish Bhaiya)-2606061818.mp3\n")
    f.write(f"Language: {data.get('language_code', 'N/A')}\n")
    f.write(f"Duration: {duration_s/60:.1f} minutes\n")
    f.write("=" * 60 + "\n\n")

    if data.get("utterances"):
        for utt in data["utterances"]:
            start_ms = utt["start"]
            mm = start_ms // 60000
            ss = (start_ms % 60000) // 1000
            f.write(f"[{mm:02d}:{ss:02d}] Speaker {utt['speaker']}: {utt['text']}\n\n")
    else:
        f.write(data.get("text", "No transcript available"))

print(f"[OK] AssemblyAI transcript saved to: {assemblyai_out}")
text = data.get("text", "")
print(f"Total chars: {len(text)}")

# ── 2. GEMINI ──────────────────────────────────────────────────
print("\n" + "=" * 60)
print("STEP 2: Running Gemini Transcription")
print("=" * 60)

try:
    from google import genai
    from google.genai import types
    print("Using google.genai (new SDK)")
    use_new_sdk = True
except ImportError:
    use_new_sdk = False
    print("google.genai not found, trying old SDK...")

for i, key in enumerate(GEMINI_KEYS):
    try:
        print(f"\nTrying Gemini API Key {i+1}...")

        if use_new_sdk:
            client = genai.Client(api_key=key)

            print("Uploading audio to Gemini Files API...")
            with open(AUDIO_FILE, "rb") as f_audio:
                audio_file = client.files.upload(
                    file=f_audio,
                    config=types.UploadFileConfig(
                        mime_type="audio/mp3",
                        display_name="bhavishya_malika_puran"
                    )
                )
            print(f"Uploaded. Name: {audio_file.name}")

            print("Waiting for Gemini to process...")
            while audio_file.state.name == "PROCESSING":
                time.sleep(5)
                audio_file = client.files.get(name=audio_file.name)
                print(f"  State: {audio_file.state.name}")

            if audio_file.state.name == "FAILED":
                print("File processing failed, trying next key...")
                continue

            print("Generating transcript...")
            response = client.models.generate_content(
                model="gemini-2.0-flash",
                contents=[
                    types.Part.from_uri(file_uri=audio_file.uri, mime_type="audio/mp3"),
                    GEMINI_PROMPT
                ],
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    max_output_tokens=65536,
                )
            )
        else:
            import google.generativeai as genai_old
            genai_old.configure(api_key=key)

            print("Uploading audio to Gemini Files API...")
            audio_file = genai_old.upload_file(path=AUDIO_FILE, mime_type="audio/mp3")
            print(f"Uploaded. URI: {audio_file.uri}")

            while audio_file.state.name == "PROCESSING":
                time.sleep(5)
                audio_file = genai_old.get_file(audio_file.name)
                print(f"  State: {audio_file.state.name}")

            if audio_file.state.name == "FAILED":
                print("Failed, trying next key...")
                continue

            model = genai_old.GenerativeModel("gemini-2.0-flash")
            response = model.generate_content(
                [audio_file, GEMINI_PROMPT],
                generation_config=genai_old.GenerationConfig(temperature=0.1, max_output_tokens=65536)
            )

        gemini_transcript = response.text

        gemini_out = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\gemini_transcript.txt"
        with open(gemini_out, "w", encoding="utf-8") as f:
            f.write("=" * 60 + "\n")
            f.write("GEMINI TRANSCRIPT\n")
            f.write(f"File : bhavishya malika puran (Manish Bhaiya)-2606061818.mp3\n")
            f.write(f"Model: gemini-2.0-flash | Key: {i+1}\n")
            f.write("=" * 60 + "\n\n")
            f.write(gemini_transcript)

        print(f"[OK] Gemini transcript saved to: {gemini_out}")
        print(f"Total chars: {len(gemini_transcript)}")
        print("\n--- PREVIEW ---")
        print(gemini_transcript[:600])
        break

    except Exception as e:
        print(f"Key {i+1} error: {e}")
        continue

print("\n" + "=" * 60)
print("DONE! Both transcripts saved.")
print("=" * 60)
