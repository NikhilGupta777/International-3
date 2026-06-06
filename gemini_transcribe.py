import google.generativeai as genai
import time
import os

API_KEYS = [
    "AIzaSyDkboQNcUg3fPJ5JmSRF8Mu8-nyBoTMo3o",
    "AIzaSyCIBc2zjXic8YGHjZhMjxF9VPRcqVow7H8",
    "AIzaSyD7ImSAVy7XYpUEyNwn5XQwZH5FULNbFfw",
]

AUDIO_FILE = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\bhavishya malika puran (Manish Bhaiya)-2606061818.mp3"

PROMPT = """You are a professional transcription specialist. Your task is to produce a highly accurate, well-formatted transcript of the provided audio recording.

STRICT INSTRUCTIONS:
1. Transcribe EVERY word spoken — do not skip, summarize, or paraphrase anything.
2. Detect the language automatically. If Hindi/Hinglish/mixed language is spoken, transcribe in the EXACT language used (Devanagari for Hindi words, English for English words).
3. Identify different speakers and label them as Speaker A, Speaker B, etc. (or use names if mentioned in the audio).
4. Include timestamps every 30 seconds in [MM:SS] format.
5. Format each speaker turn as a new line: [MM:SS] Speaker X: <text>
6. Mark unclear/inaudible words as [inaudible] and uncertain words with (word?).
7. Preserve natural speech including filler words like "um", "uh", "hmm", "haan", "acha", etc.
8. Do NOT add any commentary, notes, or summaries — only the transcript.
9. Maintain the exact flow and sequence of the conversation.
10. If music or non-speech sounds occur, note them as [music], [background noise], etc.

Begin the transcript now:"""

def transcribe_with_gemini():
    last_error = None
    for i, key in enumerate(API_KEYS):
        try:
            print(f"Trying API Key {i+1}...")
            genai.configure(api_key=key)

            print("Uploading audio file to Gemini Files API...")
            audio_file = genai.upload_file(
                path=AUDIO_FILE,
                mime_type="audio/mp3",
                display_name="bhavishya_malika_puran"
            )
            print(f"Upload complete. File URI: {audio_file.uri}")

            # Wait for file to be processed
            print("Waiting for file processing...")
            while audio_file.state.name == "PROCESSING":
                time.sleep(5)
                audio_file = genai.get_file(audio_file.name)
                print(f"  State: {audio_file.state.name}")

            if audio_file.state.name == "FAILED":
                print("File processing failed, trying next key...")
                continue

            print("Generating transcript...")
            model = genai.GenerativeModel("gemini-2.0-flash")
            response = model.generate_content(
                [audio_file, PROMPT],
                generation_config=genai.GenerationConfig(
                    temperature=0.1,
                    max_output_tokens=65536,
                )
            )

            transcript = response.text

            # Save to file
            output_path = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\gemini_transcript.txt"
            with open(output_path, "w", encoding="utf-8") as f:
                f.write("=== GEMINI TRANSCRIPT ===\n")
                f.write(f"File: bhavishya malika puran (Manish Bhaiya)-2606061818.mp3\n")
                f.write(f"Model: gemini-2.0-flash\n")
                f.write(f"API Key Used: Key {i+1}\n")
                f.write("=" * 50 + "\n\n")
                f.write(transcript)

            print("\n" + "="*50)
            print("=== GEMINI TRANSCRIPT ===")
            print("="*50)
            print(transcript)
            print("="*50)
            print(f"\nTranscript saved to: {output_path}")
            return

        except Exception as e:
            last_error = e
            print(f"Key {i+1} failed: {e}")
            continue

    print(f"All API keys failed. Last error: {last_error}")

if __name__ == "__main__":
    transcribe_with_gemini()
