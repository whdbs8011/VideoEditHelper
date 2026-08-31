from __future__ import annotations

import unittest
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import patch

from config import BuildConfig, ResolvedStoryboardItem
from premiere_builder import execute_jsx, generate_jsx


class PremiereBuilderTests(unittest.TestCase):
    def test_execute_jsx_parses_skipped_count(self) -> None:
        with TemporaryDirectory() as directory:
            jsx_path = Path(directory) / "build.jsx"
            jsx_path.touch()
            pymiere_module = ModuleType("pymiere")
            core_module = ModuleType("pymiere.core")
            core_module.eval_script = lambda **_kwargs: "STORYBOARD_RESULT|OK|7|3|2|Main"

            with patch.dict(
                sys.modules,
                {"pymiere": pymiere_module, "pymiere.core": core_module},
            ):
                result = execute_jsx(jsx_path)

        self.assertEqual(result.placed, 7)
        self.assertEqual(result.imported, 3)
        self.assertEqual(result.skipped, 2)
        self.assertEqual(result.sequence_name, "Main")

    def test_generate_jsx_accepts_empty_storyboard_without_creating_bin(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            config = BuildConfig(
                storyboard_path=tmp_path / "storyboard.xlsx",
                media_root=tmp_path / "media",
                project_path=tmp_path / "project.prproj",
                output_jsx=tmp_path / "build.jsx",
            )

            script = generate_jsx(config, [])

        self.assertIn("var rows = [];", script)
        self.assertIn("var targetBin = null;", script)

    def test_generate_jsx_embeds_cross_platform_paths_as_utf16(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            project = tmp_path / "프로젝트.prproj"
            media = tmp_path / "미디어" / "클립.mp4"
            config = BuildConfig(
                storyboard_path=tmp_path / "storyboard.csv",
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
        self.assertIn("getOrImportItem", script)
        self.assertIn("itemCache", script)
        self.assertNotIn(str(media), script)


if __name__ == "__main__":
    unittest.main()
