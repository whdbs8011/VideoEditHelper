"""Shared data models and defaults for the storyboard pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Final


SUPPORTED_MEDIA_EXTENSIONS: Final[frozenset[str]] = frozenset(
    {
        ".avi",
        ".jpeg",
        ".jpg",
        ".m4v",
        ".mkv",
        ".mov",
        ".mp4",
        ".mxf",
        ".png",
        ".tif",
        ".tiff",
        ".wav",
        ".webm",
    }
)
DEFAULT_BIN_NAME: Final[str] = "Storyboard Media"
DEFAULT_JSX_NAME: Final[str] = "storyboard_build.jsx"


@dataclass(frozen=True, slots=True)
class StoryboardItem:
    """One validated row from the storyboard CSV.

    ``track_index`` is one-based to match the Premiere Pro user interface.
    ``duration`` is the visible timeline duration in seconds, when supplied.
    """

    file_name: str
    start_time: float
    duration: float | None = None
    track_index: int = 1
    source_row: int = 0


@dataclass(frozen=True, slots=True)
class ResolvedStoryboardItem:
    """A storyboard row whose media file has been resolved on disk."""

    media_path: Path
    start_time: float
    duration: float | None
    track_index: int
    source_row: int


@dataclass(frozen=True, slots=True)
class BuildConfig:
    """Runtime settings used to generate and execute the Premiere script."""

    csv_path: Path
    media_root: Path
    project_path: Path
    sequence_name: str | None = None
    output_jsx: Path = Path(DEFAULT_JSX_NAME)
    bin_name: str = DEFAULT_BIN_NAME
    place_audio: bool = True
    save_project: bool = True
