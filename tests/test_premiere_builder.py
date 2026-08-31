from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from config import BuildConfig, ResolvedStoryboardItem
from premiere_builder import generate_jsx


class PremiereBuilderTests(unittest.TestCase):
    def test_generate_jsx_embeds_cross_platform_paths_as_utf16(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            project = tmp_path / "프로젝트.prproj"
            media = tmp_path / "미디어" / "클립.mp4"
            config = BuildConfig(
                csv_path=tmp_path / "storyboard.csv",
                media_root=tmp_path / "미디어",
                project_path=project,
                sequence_name="메인 시퀀스",
                output_jsx=tmp_path / "build.jsx",
            )
            item = ResolvedStoryboardItem(
                media_path=media,
                start_time=1.25,
                duration=3.5,
                track_index=2,
                source_row=2,
            )
            script = generate_jsx(config, [item])

        self.assertIn("String.fromCharCode(", script)
        self.assertIn("start:1.25,duration:3.5,track:1,row:2", script)
        self.assertIn("sequence.overwriteClip", script)
        self.assertNotIn(str(media), script)


if __name__ == "__main__":
    unittest.main()
