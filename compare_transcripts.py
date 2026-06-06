import re
import difflib

# Let's read both transcript files
assemblyai_path = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\assemblyai_transcript.txt"
gemini_path = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\gemini_transcript.txt"

with open(assemblyai_path, 'r', encoding='utf-8') as f:
    assembly_raw = f.read()

with open(gemini_path, 'r', encoding='utf-8') as f:
    gemini_raw = f.read()

# Parse timestamps and speakers
def parse_transcript(text):
    # Match lines like [MM:SS] Speaker X: text
    pattern = re.compile(r'\[(\d{2}):(\d{2})\]\s+Speaker\s+([A-Za-z0-9]+):\s*(.*)')
    parsed = []
    for line in text.split('\n'):
        m = pattern.match(line.strip())
        if m:
            mm, ss, speaker, content = m.groups()
            time_sec = int(mm) * 60 + int(ss)
            parsed.append({
                'time_str': f"[{mm}:{ss}]",
                'time_sec': time_sec,
                'speaker': speaker,
                'text': content.strip()
            })
    return parsed

assembly_parsed = parse_transcript(assembly_raw)
gemini_parsed = parse_transcript(gemini_raw)

print(f"AssemblyAI entries: {len(assembly_parsed)}")
print(f"Gemini entries: {len(gemini_parsed)}")

# Compare entries by matching timestamps closely (within 5 seconds)
comparisons = []
gemini_used = set()

for a_entry in assembly_parsed:
    # Find matching gemini entry
    best_match = None
    min_diff = 6 # Max 5 seconds diff
    for idx, g_entry in enumerate(gemini_parsed):
        diff = abs(a_entry['time_sec'] - g_entry['time_sec'])
        if diff < min_diff:
            best_match = g_entry
            min_diff = diff
            
    if best_match:
        comparisons.append((a_entry, best_match))
        gemini_used.add(id(best_match))
    else:
        comparisons.append((a_entry, None))

# Add unmatched gemini entries
for g_entry in gemini_parsed:
    if id(g_entry) not in gemini_used:
        comparisons.append((None, g_entry))

# Sort by time
comparisons.sort(key=lambda x: x[0]['time_sec'] if x[0] else x[1]['time_sec'])

# Write comparison results to a file
compare_out = r"c:\Users\g_n-n\Desktop\apps\international-3 clone\International-3\transcript_comparison.txt"
with open(compare_out, 'w', encoding='utf-8') as f:
    f.write("="*80 + "\n")
    f.write("TRANSCRIPT COMPARISON: ASSEMBLYAI vs GEMINI (gemini-2.5-flash)\n")
    f.write("="*80 + "\n\n")
    
    mismatches = 0
    for a, g in comparisons:
        time_str = a['time_str'] if a else g['time_str']
        
        if a and g:
            # Check if there is significant difference in text
            # Normalize text for simple comparison (remove punctuation, spaces)
            a_norm = re.sub(r'[^\w\s]', '', a['text']).replace(' ', '').lower()
            g_norm = re.sub(r'[^\w\s]', '', g['text']).replace(' ', '').lower()
            
            if a_norm != g_norm:
                mismatches += 1
                f.write(f"{time_str} DIFFERENCE FOUND:\n")
                f.write(f"  AssemblyAI (Spk {a['speaker']}): {a['text']}\n")
                f.write(f"  Gemini     (Spk {g['speaker']}): {g['text']}\n")
                f.write("-" * 40 + "\n")
        elif a:
            mismatches += 1
            f.write(f"{time_str} ONLY IN ASSEMBLYAI:\n")
            f.write(f"  AssemblyAI (Spk {a['speaker']}): {a['text']}\n")
            f.write("-" * 40 + "\n")
        elif g:
            mismatches += 1
            f.write(f"{time_str} ONLY IN GEMINI:\n")
            f.write(f"  Gemini     (Spk {g['speaker']}): {g['text']}\n")
            f.write("-" * 40 + "\n")

    f.write(f"\nTotal differences/mismatches: {mismatches}\n")

print(f"Comparison report saved to: {compare_out}")
print(f"Total differences found: {mismatches}")
