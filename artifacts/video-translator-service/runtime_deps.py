import sys
from pathlib import Path


SKIP_RUNTIME_REQUIREMENT_PREFIXES = (
    "torch==",
    "torchvision==",
    "torchaudio==",
    "--extra-index-url",
    "accelerate==",
    "diffusers==",
    "einops==",
    "ffmpeg-python==",
    "huggingface-hub==",
    "huggingface_hub==",
    "librosa==",
    "gradio==",
    "mediapipe==",
    "numpy==",
    "onnxruntime-gpu==",
    "opencv-python==",
    "omegaconf==",
    "opencv-python-headless==",
    "transformers==",
)


def filter_runtime_requirements(lines: list[str]) -> list[str]:
    filtered: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            filtered.append(raw_line)
            continue
        if any(line.startswith(prefix) for prefix in SKIP_RUNTIME_REQUIREMENT_PREFIXES):
            continue
        filtered.append(raw_line)
    return filtered


def write_runtime_requirements(source: Path, destination: Path) -> Path:
    destination.write_text(
        "".join(filter_runtime_requirements(source.read_text(encoding="utf-8").splitlines(True))),
        encoding="utf-8",
    )
    return destination


def pip_install_command(requirements: Path, constraints: Path | None = None) -> list[str]:
    command = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--quiet",
        "--prefer-binary",
    ]
    if constraints and constraints.exists():
        command.extend(["-c", str(constraints)])
    command.extend(["-r", str(requirements)])
    return command
