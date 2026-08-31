"""Validation, parsing, and media resolution for storyboard CSV files."""

from __future__ import annotations

import csv
import logging
import math
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from config import ResolvedStoryboardItem, StoryboardItem, SUPPORTED_MEDIA_EXTENSIONS

LOGGER = logging.getLogger(__name__)
REQUIRED_COLUMNS = frozenset({"file_name", "start_time"})
OPTIONAL_COLUMNS = frozenset({"duration", "track_index"})
_TIMECODE_RE = re.compile(
    r"^(?P<hours>\d+):(?P<minutes>[0-5]?\d):(?P<seconds>[0-5]?\d(?:\.\d+)?)$"
)


class StoryboardValidationError(ValueError):
    """Raised when the CSV or referenced media is invalid."""


def parse_time(value: str, *, field_name: str, row_number: int) -> float:
    """Parse non-negative seconds or ``HH:MM:SS[.sss]`` into seconds."""

    text = value.strip()
    if not text:
        raise StoryboardValidationError(
            f"Row {row_number}: {field_name} must not be empty."
        )

    match = _TIMECODE_RE.fullmatch(text)
    try:
        if match:
            seconds = (
                int(match.group("hours")) * 3600
                + int(match.group("minutes")) * 60
                + float(match.group("seconds"))
            )
        else:
            seconds = float(text)
    except ValueError as exc:
        raise StoryboardValidationError(
            f"Row {row_number}: invalid {field_name} value {value!r}. "
            "Use seconds or HH:MM:SS."
        ) from exc

    if not math.isfinite(seconds) or seconds < 0:
        raise StoryboardValidationError(
            f"Row {row_number}: {field_name} must be a finite, non-negative time."
        )
    return seconds


def parse_storyboard(csv_path: Path) -> list[StoryboardItem]:
    """Read and validate a UTF-8 CSV storyboard.

    UTF-8 BOM files exported by spreadsheet applications are accepted.
    All validation errors are collected so the user can repair the CSV once.
    """

    path = csv_path.expanduser().resolve()
    if not path.is_file():
        raise StoryboardValidationError(f"CSV file does not exist: {path}")

    items: list[StoryboardItem] = []
    errors: list[str] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            if reader.fieldnames is None:
                raise StoryboardValidationError("CSV is empty or has no header row.")

            reader.fieldnames = [name.strip() if name else "" for name in reader.fieldnames]
            headers = {name for name in reader.fieldnames if name}
            missing = sorted(REQUIRED_COLUMNS - headers)
            if missing:
                raise StoryboardValidationError(
                    f"CSV is missing required column(s): {', '.join(missing)}"
                )

            unknown = sorted(headers - REQUIRED_COLUMNS - OPTIONAL_COLUMNS)
            if unknown:
                LOGGER.warning("Ignoring unknown CSV columns: %s", ", ".join(unknown))

            for row_number, raw_row in enumerate(reader, start=2):
                if None in raw_row:
                    errors.append(
                        f"Row {row_number}: row has more values than the CSV header."
                    )
                    continue
                if not any((value or "").strip() for value in raw_row.values()):
                    continue
                try:
                    file_name = (raw_row.get("file_name") or "").strip()
                    if not file_name:
                        raise StoryboardValidationError(
                            f"Row {row_number}: file_name must not be empty."
                        )
                    if Path(file_name).is_absolute() or ".." in Path(file_name).parts:
                        raise StoryboardValidationError(
                            f"Row {row_number}: file_name must be relative to media_root."
                        )

                    start_time = parse_time(
                        raw_row.get("start_time") or "",
                        field_name="start_time",
                        row_number=row_number,
                    )
                    duration_text = (raw_row.get("duration") or "").strip()
                    duration = (
                        parse_time(
                            duration_text,
                            field_name="duration",
                            row_number=row_number,
                        )
                        if duration_text
                        else None
                    )
                    if duration == 0:
                        raise StoryboardValidationError(
                            f"Row {row_number}: duration must be greater than zero."
                        )

                    track_text = (raw_row.get("track_index") or "").strip() or "1"
                    try:
                        track_index = int(track_text)
                    except ValueError as exc:
                        raise StoryboardValidationError(
                            f"Row {row_number}: track_index must be a positive integer."
                        ) from exc
                    if track_index < 1:
                        raise StoryboardValidationError(
                            f"Row {row_number}: track_index must be at least 1."
                        )

                    items.append(
                        StoryboardItem(
                            file_name=file_name,
                            start_time=start_time,
                            duration=duration,
                            track_index=track_index,
                            source_row=row_number,
                        )
                    )
                except StoryboardValidationError as exc:
                    errors.append(str(exc))
    except UnicodeDecodeError as exc:
        raise StoryboardValidationError(
            f"CSV must be UTF-8 encoded: {path}"
        ) from exc

    if errors:
        raise StoryboardValidationError("CSV validation failed:\n- " + "\n- ".join(errors))
    if not items:
        raise StoryboardValidationError("CSV contains no storyboard rows.")
    return items


def resolve_media_files(
    items: Iterable[StoryboardItem], media_root: Path
) -> list[ResolvedStoryboardItem]:
    """Resolve CSV file names against ``media_root`` recursively.

    Names with extensions first try the exact relative path, then a basename
    lookup. Extensionless names match by stem. Ambiguous and missing matches are
    reported together.
    """

    root = media_root.expanduser().resolve()
    if not root.is_dir():
        raise StoryboardValidationError(f"Media directory does not exist: {root}")

    files = sorted(
        (
            path.resolve()
            for path in root.rglob("*")
            if path.is_file() and path.suffix.casefold() in SUPPORTED_MEDIA_EXTENSIONS
        ),
        key=lambda path: path.as_posix().casefold(),
    )
    by_name: dict[str, list[Path]] = defaultdict(list)
    by_stem: dict[str, list[Path]] = defaultdict(list)
    for path in files:
        by_name[path.name.casefold()].append(path)
        by_stem[path.stem.casefold()].append(path)

    resolved: list[ResolvedStoryboardItem] = []
    errors: list[str] = []
    for item in items:
        requested = Path(item.file_name)
        exact = (root / requested).resolve()
        candidates: list[Path]
        try:
            exact.relative_to(root)
        except ValueError:
            candidates = []
        else:
            candidates = [exact] if exact.is_file() else []

        if not candidates:
            lookup = by_name if requested.suffix else by_stem
            key = requested.name.casefold() if requested.suffix else requested.stem.casefold()
            candidates = lookup.get(key, [])

        if not candidates:
            errors.append(f"Row {item.source_row}: media not found: {item.file_name}")
            continue
        if len(candidates) > 1:
            choices = ", ".join(str(path.relative_to(root)) for path in candidates)
            errors.append(
                f"Row {item.source_row}: ambiguous media {item.file_name!r}; "
                f"use a relative path. Candidates: {choices}"
            )
            continue

        resolved.append(
            ResolvedStoryboardItem(
                media_path=candidates[0],
                start_time=item.start_time,
                duration=item.duration,
                track_index=item.track_index,
                source_row=item.source_row,
            )
        )

    if errors:
        raise StoryboardValidationError(
            "Media resolution failed:\n- " + "\n- ".join(errors)
        )
    return resolved
