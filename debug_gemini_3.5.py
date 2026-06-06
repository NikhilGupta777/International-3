import time
from google import genai
from google.genai import types

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

key = GEMINI_KEYS[1] # Use Key 2 which was successful but returned empty
client = genai.Client(api_key=key)

print("Uploading file...")
with open(AUDIO_FILE, "rb") as f_audio:
    audio_file = client.files.upload(
        file=f_audio,
        config=types.UploadFileConfig(
            mime_type="audio/mp3",
            display_name="bhavishya_malika_puran_debug"
        )
    )
print(f"Uploaded. Name: {audio_file.name}, State: {audio_file.state}")

# Wait if processing
while audio_file.state.name == "PROCESSING":
    print("Processing...")
    time.sleep(5)
    audio_file = client.files.get(name=audio_file.name)

print(f"Final State: {audio_file.state}")

print("Sending request to gemini-3.5-flash...")
try:
    response = client.models.generate_content(
        model="gemini-3.5-flash",
        contents=[
            audio_file, # Let's try passing the file object directly, as supported by the SDK!
            GEMINI_PROMPT
        ],
        config=types.GenerateContentConfig(
            temperature=0.1,
            max_output_tokens=65536,
        )
    )
    
    print("\n--- RESPONSE OBJECT ---")
    print(response)
    print("\n--- TEXT ---")
    print(repr(response.text))
    print("\n--- CANDIDATES ---")
    if response.candidates:
        for idx, candidate in enumerate(response.candidates):
            print(f"Candidate {idx}:")
            print(f"  Finish Reason: {candidate.finish_reason}")
            print(f"  Safety Ratings: {candidate.safety_ratings}")
            print(f"  Content parts: {candidate.content.parts if candidate.content else 'None'}")
    else:
        print("No candidates returned!")

except Exception as e:
    print(f"Error occurred: {e}")
