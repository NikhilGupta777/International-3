import pathlib

file = pathlib.Path('artifacts/video-translator-service/worker.py')
text = file.read_text(encoding='utf-8')

# 1. Fix dynamic_timewarp_background_track which got mangled by the tool
bad_block = """    out_path = out_dir / "background_timewarped.wav"
    update_progress("EXTRACTING", 8, "Extracting high-quality audio...")
    if not video_has_audio_stream(video_path):
        raise RuntimeError("Input video has no audio stream; video translation requires spoken audio.")
    full_audio_hq = work_dir / "audio_full_44100hz.wav"
    transcription_audio = work_dir / "audio_full_16k.wav"
    run_ffmpeg(
        "-i", str(video_path),
        "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", str(full_audio_hq),
        "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(transcription_audio),
    )
    reference_audio = full_audio_hq

    log.info("[Dynamic] Background track time-warped to match the picture.")
    return out_path"""

good_block = """    out_path = out_dir / "background_timewarped.wav"
    run_ffmpeg(
        "-i", str(background_audio),
        "-filter_complex", filter_complex,
        "-map", "[outa]", "-ar", str(sr),
        str(out_path),
    )
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise RuntimeError("Background time-warp produced no output.")
    
    log.info("[Dynamic] Background track time-warped to match the picture.")
    return out_path"""

if bad_block in text:
    text = text.replace(bad_block, good_block)
    print("Fixed dynamic_timewarp_background_track")
else:
    print("bad_block not found in worker.py, might be already fixed?")

# 2. Fix the audio extraction
old_extract1 = """        # ── 2. Extract audio ──────────────────────────────────────────────────
        update_progress("EXTRACTING", 8, "Extracting high-quality audio...")
        full_audio_hq = extract_audio(video_path, work_dir, sample_rate=44100, mono=True, label="audio_full")
        transcription_audio = resample_audio(full_audio_hq, work_dir / "audio_full_16k.wav", 16000, mono=True)
        reference_audio = full_audio_hq"""

old_extract2 = """        # â”€â”€ 2. Extract audio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        update_progress("EXTRACTING", 8, "Extracting high-quality audio...")
        full_audio_hq = extract_audio(video_path, work_dir, sample_rate=44100, mono=True, label="audio_full")
        transcription_audio = resample_audio(full_audio_hq, work_dir / "audio_full_16k.wav", 16000, mono=True)
        reference_audio = full_audio_hq"""

new_extract = """        # ── 2. Extract audio ──────────────────────────────────────────────────
        update_progress("EXTRACTING", 8, "Extracting high-quality audio...")
        if not video_has_audio_stream(video_path):
            raise RuntimeError("Input video has no audio stream; video translation requires spoken audio.")
        full_audio_hq = work_dir / "audio_full_44100hz.wav"
        transcription_audio = work_dir / "audio_full_16k.wav"
        run_ffmpeg(
            "-i", str(video_path),
            "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", str(full_audio_hq),
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", str(transcription_audio),
        )
        reference_audio = full_audio_hq"""

if old_extract1 in text:
    text = text.replace(old_extract1, new_extract)
    print("Fixed audio extraction (standard block)")
elif old_extract2 in text:
    text = text.replace(old_extract2, new_extract)
    print("Fixed audio extraction (utf-8 mangled block)")
else:
    print("Could not find extract block to replace")

file.write_text(text, encoding='utf-8')
print("Write complete.")
