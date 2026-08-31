from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from csv_parser import (
    StoryboardValidationError,
    parse_storyboard,
    parse_time,
    resolve_media_files,
)


class CsvParserTests(unittest.TestCase):
    def test_parse_time_supports_seconds_and_timecode(self) -> None:
        self.assertEqual(parse_time("12.5", field_name="start_time", row_number=2), 12.5)
        self.assertEqual(
            parse_time("01:02:03.5", field_name="start_time", row_number=2), 3723.5
        )

    def test_parse_storyboard_defaults_track_and_optional_duration(self) -> None:
        with TemporaryDirectory() as directory:
            csv_path = Path(directory) / "storyboard.csv"
            csv_path.write_text(
                "file_name,start_time,duration,track_index\nclip.mp4,00:00:01.5,,\n",
                encoding="utf-8",
            )
            [item] = parse_storyboard(csv_path)

        self.assertEqual(item.file_name, "clip.mp4")
        self.assertEqual(item.start_time, 1.5)
        self.assertIsNone(item.duration)
        self.assertEqual(item.track_index, 1)

    def test_parse_storyboard_collects_row_errors(self) -> None:
        with TemporaryDirectory() as directory:
            csv_path = Path(directory) / "bad.csv"
            csv_path.write_text(
                "file_name,start_time,duration,track_index\n,abc,,0\nclip.mp4,-1,0,x\n",
                encoding="utf-8",
            )
            with self.assertRaises(StoryboardValidationError) as caught:
                parse_storyboard(csv_path)

        self.assertIn("Row 2", str(caught.exception))
        self.assertIn("Row 3", str(caught.exception))

    def test_resolve_media_supports_relative_path_and_extensionless_name(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            media_root = tmp_path / "media"
            nested = media_root / "shots"
            nested.mkdir(parents=True)
            (nested / "scene.mov").touch()
            csv_path = tmp_path / "storyboard.csv"
            csv_path.write_text(
                "file_name,start_time\nshots/scene.mov,0\nscene,1\n",
                encoding="utf-8",
            )
            resolved = resolve_media_files(parse_storyboard(csv_path), media_root)

        self.assertEqual([item.media_path.name for item in resolved], ["scene.mov", "scene.mov"])

    def test_resolve_media_rejects_ambiguous_stem(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            media_root = tmp_path / "media"
            media_root.mkdir()
            (media_root / "same.mp4").touch()
            (media_root / "same.mov").touch()
            csv_path = tmp_path / "storyboard.csv"
            csv_path.write_text("file_name,start_time\nsame,0\n", encoding="utf-8")
            with self.assertRaisesRegex(StoryboardValidationError, "ambiguous media"):
                resolve_media_files(parse_storyboard(csv_path), media_root)

    def test_resolve_media_uses_highest_take_only_when_exact_is_missing(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            media_root = tmp_path / "media"
            media_root.mkdir()
            (media_root / "24-1.mp4").touch()
            (media_root / "24-2.mp4").touch()
            csv_path = tmp_path / "storyboard.csv"
            csv_path.write_text("file_name,start_time\n24,0\n", encoding="utf-8")

            [resolved] = resolve_media_files(parse_storyboard(csv_path), media_root)

        self.assertEqual(resolved.media_path.name, "24-2.mp4")

    def test_resolve_media_prefers_exact_stem_over_numbered_takes(self) -> None:
        with TemporaryDirectory() as directory:
            tmp_path = Path(directory)
            media_root = tmp_path / "media"
            media_root.mkdir()
            (media_root / "24.mp4").touch()
            (media_root / "24-9.mp4").touch()
            csv_path = tmp_path / "storyboard.csv"
            csv_path.write_text("file_name,start_time\n24,0\n", encoding="utf-8")

            [resolved] = resolve_media_files(parse_storyboard(csv_path), media_root)

        self.assertEqual(resolved.media_path.name, "24.mp4")


if __name__ == "__main__":
    unittest.main()
