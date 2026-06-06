from google import genai

client = genai.Client(api_key="AIzaSyDkboQNcUg3fPJ5JmSRF8Mu8-nyBoTMo3o")
try:
    for m in client.models.list():
        print(f"Name: {m.name}, Supported Actions: {m.supported_stage}")
except Exception as e:
    print(f"Error: {e}")
