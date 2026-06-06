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

# List of model candidates to try
MODELS_TO_TRY = [
    "gemini-2.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-3.5-flash"  # Retry gemini-3.5-flash with a different key or settings
]

def attempt_transcription():
    for model_name in MODELS_TO_TRY:
        print(f"\n==================================================")
        print(f"TRYING MODEL: {model_name}")
        print(f"==================================================")
        
        for i, key in enumerate(GEMINI_KEYS):
            try:
                print(f"\n--- Key {i+1} ---")
                client = genai.Client(api_key=key)

                print("Uploading audio file...")
                with open(AUDIO_FILE, "rb") as f_audio:
                    audio_file = client.files.upload(
                        file=f_audio,
                        config=types.UploadFileConfig(
                            mime_type="audio/mp3",
                            display_name=f"bhavishya_{model_name.replace('.', '_')}"
                        )
                    )
                print(f"Uploaded. Name: {audio_file.name}, State: {audio_file.state.name}")

                while audio_file.state.name == "PROCESSING":
                    time.sleep(5)
                    audio_file = client.files.get(name=audio_file.name)
                    print(f"  State: {audio_file.state.name}")

                if audio_file.state.name == "FAILED":
                    print("Upload failed.")
                    continue

                print(f"Generating content with {model_name}...")
                response = client.models.generate_content(
                    model=model_name,
                    contents=[
                        audio_file,
                        GEMINI_PROMPT
                    ],
                    config=types.GenerateContentConfig(
                        temperature=0.1,
                        max_output_tokens=65536,
                    )
                )

                # Check response
                finish_reason = response.candidates[0].finish_reason if response.candidates else "No candidates"
                print(f"Finish Reason: {finish_reason}")
                
                if response.text:
                    transcript_text = response.text
                    print(f"Success! Got transcript ({len(transcript_text)} chars).")
                    
                    gemini_out = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\gemini_transcript.txt"
                    with open(gemini_out, "w", encoding="utf-8") as f:
                        f.write("=" * 60 + "\n")
                        f.write(f"GEMINI TRANSCRIPT ({model_name})\n")
                        f.write(f"File : bhavishya malika puran (Manish Bhaiya)-2606061818.mp3\n")
                        f.write(f"Model: {model_name} | Key: {i+1}\n")
                        f.write("=" * 60 + "\n\n")
                        f.write(transcript_text)
                    
                    print(f"Saved transcript to: {gemini_out}")
                    print("\n--- PREVIEW ---")
                    print(transcript_text[:500])
                    return
                else:
                    print("Response text was empty or None.")
                    
            except Exception as e:
                print(f"Error with model {model_name} and Key {i+1}: {e}")
                continue

if __name__ == "__main__":
    attempt_transcription()
