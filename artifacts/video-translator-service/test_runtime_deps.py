import unittest
from pathlib import Path

from runtime_deps import filter_runtime_requirements, pip_install_command


class RuntimeDepsTests(unittest.TestCase):
    def test_filter_runtime_requirements_skips_preinstalled_torch_packages(self):
        lines = [
            "torch==2.5.1\n",
            "torchvision==0.20.1\n",
            "--extra-index-url https://download.pytorch.org/whl/cu121\n",
            "diffusers==0.32.2\n",
            "transformers==4.48.0\n",
            "huggingface-hub==0.30.2\n",
            "einops==0.7.0\n",
            "opencv-python==4.9.0.80\n",
            "numpy==1.26.4\n",
            "decord==0.6.0\n",
        ]

        filtered = filter_runtime_requirements(lines)

        self.assertIn("decord==0.6.0\n", filtered)
        self.assertFalse(any(line.startswith("torch==") for line in filtered))
        self.assertFalse(any(line.startswith("torchvision==") for line in filtered))
        self.assertFalse(any(line.startswith("diffusers==") for line in filtered))
        self.assertFalse(any(line.startswith("transformers==") for line in filtered))
        self.assertFalse(any(line.startswith("huggingface-hub==") for line in filtered))
        self.assertFalse(any(line.startswith("einops==") for line in filtered))
        self.assertFalse(any(line.startswith("numpy==") for line in filtered))
        self.assertFalse(any(line.startswith("--extra-index-url") for line in filtered))

    def test_filter_runtime_requirements_uses_headless_opencv(self):
        filtered = filter_runtime_requirements(["opencv-python==4.9.0.80\n"])

        self.assertEqual(filtered, ["opencv-python-headless==4.9.0.80\n"])

    def test_pip_install_command_uses_constraints_when_present(self):
        import tempfile

        with tempfile.TemporaryDirectory() as temp_dir:
            tmp_path = Path(temp_dir)
            requirements = tmp_path / "requirements.runtime.txt"
            constraints = tmp_path / "constraints.txt"
            requirements.write_text("numpy==1.26.4\n", encoding="utf-8")
            constraints.write_text("numpy==1.26.4\n", encoding="utf-8")

            command = pip_install_command(requirements, constraints)

        self.assertIn("-c", command)
        self.assertIn(str(constraints), command)
        self.assertIn(str(requirements), command)


if __name__ == "__main__":
    unittest.main()
