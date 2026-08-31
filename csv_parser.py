"""Validation, parsing, and media resolution for CSV/XLSX storyboards."""

from __future__ import annotations

import csv
import logging
import math
import posixpath
import re
import unicodedata
import zipfile
from collections import defaultdict
from pathlib import Path
from typing import Iterable, TypeAlias
from xml.etree import ElementTree

from config import (
    ResolvedStoryboardItem,
    StoryboardItem,
    SUPPORTED_MEDIA_EXTENSIONS,
    SUPPORTED_STORYBOARD_EXTENSIONS,
)

LOGGER = logging.getLogger(__name__)
REQUIRED_COLUMNS = frozenset({"file_name", "start_time"})
OPTIONAL_COLUMNS = frozenset({"duration", "track_index"})
_TIMECODE_RE = re.compile(
    r"^(?P<hours>\d+):(?P<minutes>[0-5]?\d):(?P<seconds>[0-5]?\d(?:\.\d+)?)$"
)
_XLSX_MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_XLSX_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_CellValue: TypeAlias = str | int | float | bool | None
_SheetRows: TypeAlias = list[tuple[int, dict[int, _CellValue]]]


class StoryboardValidationError(ValueError):
    """Raised when the storyboard file or referenced media is invalid."""


def _normalise_header(value: object) -> str:
    """Normalise Unicode and whitespace for exported spreadsheet headers."""

    text = unicodedata.normalize("NFC", str(value or "")).strip()
    return re.sub(r"\s+", "", text).casefold()


def _validate_file_name(value: object, row_number: int) -> str:
    """Validate a media name and return its stripped string form."""

    file_name = str("" if value is None else value).strip()
    if not file_name:
        raise StoryboardValidationError(
            f"Row {row_number}: file_name must not be empty."
        )
    requested = Path(file_name)
    if requested.is_absolute() or ".." in requested.parts:
        raise StoryboardValidationError(
            f"Row {row_number}: file_name must be relative to media_root."
        )
    return file_name


def _parse_track(value: object, row_number: int) -> int:
    """Parse a one-based Premiere track index."""

    text = str("" if value is None else value).strip() or "1"
    try:
        number = float(text)
        track_index = int(number)
    except (OverflowError, ValueError) as exc:
        raise StoryboardValidationError(
            f"Row {row_number}: track_index must be a positive integer."
        ) from exc
    if not math.isfinite(number) or number != track_index or track_index < 1:
        raise StoryboardValidationError(
            f"Row {row_number}: track_index must be at least 1."
        )
    return track_index


def _parse_optional_duration(value: object, row_number: int) -> float | None:
    """Parse an optional duration value."""

    text = str("" if value is None else value).strip()
    if not text:
        return None
    duration = parse_time(text, field_name="duration", row_number=row_number)
    if duration == 0:
        raise StoryboardValidationError(
            f"Row {row_number}: duration must be greater than zero."
        )
    return duration


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
                    file_name = _validate_file_name(
                        raw_row.get("file_name"), row_number
                    )

                    start_time = parse_time(
                        raw_row.get("start_time") or "",
                        field_name="start_time",
                        row_number=row_number,
                    )
                    duration = _parse_optional_duration(
                        raw_row.get("duration"), row_number
                    )
                    track_index = _parse_track(raw_row.get("track_index"), row_number)

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


def _column_index(reference: str) -> int:
    """Convert an Excel cell reference column to a zero-based index."""

    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        raise StoryboardValidationError(f"Invalid XLSX cell reference: {reference}")
    result = 0
    for character in letters.group(0):
        result = result * 26 + ord(character) - ord("A") + 1
    return result - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    """Read the optional XLSX shared string table."""

    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return [
        "".join(node.text or "" for node in item.iter(f"{{{_XLSX_MAIN_NS}}}t"))
        for item in root.findall(f"{{{_XLSX_MAIN_NS}}}si")
    ]


def _cell_value(cell: ElementTree.Element, shared: list[str]) -> _CellValue:
    """Decode one OOXML cell using cached formula values when present."""

    cell_type = cell.get("t", "n")
    if cell_type == "inlineStr":
        return "".join(
            node.text or "" for node in cell.iter(f"{{{_XLSX_MAIN_NS}}}t")
        )
    value_node = cell.find(f"{{{_XLSX_MAIN_NS}}}v")
    if value_node is None or value_node.text is None:
        return None
    value = value_node.text
    if cell_type == "s":
        try:
            return shared[int(value)]
        except (IndexError, ValueError) as exc:
            raise StoryboardValidationError("XLSX shared string table is invalid.") from exc
    if cell_type in {"str", "e"}:
        return value
    if cell_type == "b":
        return value == "1"
    try:
        number = float(value)
    except ValueError:
        return value
    return int(number) if number.is_integer() else number


def _xlsx_sheet_targets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    """Return worksheet names and package paths in workbook order."""

    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    relationships = ElementTree.fromstring(
        archive.read("xl/_rels/workbook.xml.rels")
    )
    targets = {
        relationship.get("Id"): relationship.get("Target")
        for relationship in relationships.findall(
            f"{{{_PACKAGE_REL_NS}}}Relationship"
        )
    }
    result: list[tuple[str, str]] = []
    for sheet in workbook.findall(f".//{{{_XLSX_MAIN_NS}}}sheet"):
        relationship_id = sheet.get(f"{{{_XLSX_REL_NS}}}id")
        target = targets.get(relationship_id)
        if target:
            sheet_path = posixpath.normpath(
                posixpath.join("xl", target)
            ).lstrip("/")
            result.append((sheet.get("name", "Sheet"), sheet_path))
    return result


def _read_xlsx_rows(
    archive: zipfile.ZipFile, sheet_path: str, shared: list[str]
) -> _SheetRows:
    """Stream one worksheet and release XML nodes as each row is decoded."""

    rows: _SheetRows = []
    with archive.open(sheet_path) as source:
        for _event, element in ElementTree.iterparse(source, events=("end",)):
            if element.tag != f"{{{_XLSX_MAIN_NS}}}row":
                continue
            row_number = int(element.get("r", len(rows) + 1))
            values: dict[int, _CellValue] = {}
            for cell in element.findall(f"{{{_XLSX_MAIN_NS}}}c"):
                reference = cell.get("r", "")
                values[_column_index(reference)] = _cell_value(cell, shared)
            rows.append((row_number, values))
            element.clear()
    return rows


def _header_map(values: dict[int, _CellValue]) -> dict[str, int]:
    """Return normalised non-empty header values mapped to columns."""

    return {
        _normalise_header(value): column
        for column, value in values.items()
        if _normalise_header(value)
    }


def _format_cut_number(value: object, row_number: int) -> str:
    """Convert a legacy cut number into an extensionless media stem."""

    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return _validate_file_name(value, row_number)


def _legacy_seconds(value: object, field_name: str, row_number: int) -> float:
    """Convert an Excel time serial or textual timecode to seconds."""

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        seconds = round(float(value) * 86400.0, 6)
        if math.isfinite(seconds) and seconds >= 0:
            return seconds
    return parse_time(str(value or ""), field_name=field_name, row_number=row_number)


def _assign_legacy_tracks(items: list[StoryboardItem]) -> list[StoryboardItem]:
    """Assign non-overlapping tracks independently of worksheet row ordering."""

    track_ends: list[float] = []
    assigned = [1] * len(items)
    chronological = sorted(
        range(len(items)), key=lambda index: (items[index].start_time, items[index].source_row)
    )
    for item_index in chronological:
        item = items[item_index]
        end = item.start_time + (item.duration or 0.0)
        for track_index, track_end in enumerate(track_ends):
            if track_end <= item.start_time + 1e-6:
                track_ends[track_index] = end
                assigned[item_index] = track_index + 1
                break
        else:
            track_ends.append(end)
            assigned[item_index] = len(track_ends)

    return [
        StoryboardItem(
            file_name=item.file_name,
            start_time=item.start_time,
            duration=item.duration,
            track_index=assigned[index],
            source_row=item.source_row,
        )
        for index, item in enumerate(items)
    ]


def _parse_normalised_xlsx(
    rows: _SheetRows, header_index: int, headers: dict[str, int]
) -> list[StoryboardItem]:
    """Parse an XLSX sheet that already uses the documented CSV schema."""

    items: list[StoryboardItem] = []
    errors: list[str] = []
    for row_number, values in rows[header_index + 1 :]:
        if not any(value not in (None, "") for value in values.values()):
            continue
        try:
            def get(name: str) -> _CellValue:
                return values.get(headers[name]) if name in headers else None

            start_value = get("start_time")
            items.append(
                StoryboardItem(
                    file_name=_validate_file_name(get("file_name"), row_number),
                    start_time=parse_time(
                        str("" if start_value is None else start_value),
                        field_name="start_time",
                        row_number=row_number,
                    ),
                    duration=_parse_optional_duration(get("duration"), row_number),
                    track_index=_parse_track(get("track_index"), row_number),
                    source_row=row_number,
                )
            )
        except StoryboardValidationError as exc:
            errors.append(str(exc))
    if errors:
        raise StoryboardValidationError("XLSX validation failed:\n- " + "\n- ".join(errors))
    return items


def _parse_legacy_xlsx(
    rows: _SheetRows, header_index: int, headers: dict[str, int]
) -> list[StoryboardItem]:
    """Map the supplied Korean cut-time workbook layout to storyboard rows."""

    cut_column = headers["컷번호"]
    start_column = headers["시작시간"]
    duration_column = (
        headers["길이(초)"] if "길이(초)" in headers else headers.get("길이초")
    )
    end_column = headers.get("종료시간")
    items: list[StoryboardItem] = []
    errors: list[str] = []
    for row_number, values in rows[header_index + 1 :]:
        cut_value = values.get(cut_column)
        if cut_value in (None, ""):
            continue
        try:
            start = _legacy_seconds(values.get(start_column), "start_time", row_number)
            duration_value = (
                values.get(duration_column) if duration_column is not None else None
            )
            if duration_value not in (None, ""):
                duration = parse_time(
                    str(duration_value), field_name="duration", row_number=row_number
                )
            elif end_column is not None:
                end = _legacy_seconds(values.get(end_column), "end_time", row_number)
                duration = end - start
            else:
                duration = None
            if duration is not None and duration <= 0:
                raise StoryboardValidationError(
                    f"Row {row_number}: duration must be greater than zero."
                )
            items.append(
                StoryboardItem(
                    file_name=_format_cut_number(cut_value, row_number),
                    start_time=start,
                    duration=duration,
                    track_index=1,
                    source_row=row_number,
                )
            )
        except StoryboardValidationError as exc:
            errors.append(str(exc))
    if errors:
        raise StoryboardValidationError("XLSX validation failed:\n- " + "\n- ".join(errors))
    return _assign_legacy_tracks(items)


def parse_xlsx_storyboard(xlsx_path: Path) -> list[StoryboardItem]:
    """Parse either the normal schema or the supplied Korean legacy XLSX layout."""

    path = xlsx_path.expanduser().resolve()
    if not path.is_file():
        raise StoryboardValidationError(f"XLSX file does not exist: {path}")
    try:
        with zipfile.ZipFile(path) as archive:
            shared = _shared_strings(archive)
            for _sheet_name, sheet_path in _xlsx_sheet_targets(archive):
                rows = _read_xlsx_rows(archive, sheet_path, shared)
                for index, (_row_number, values) in enumerate(rows):
                    headers = _header_map(values)
                    if REQUIRED_COLUMNS <= headers.keys():
                        items = _parse_normalised_xlsx(rows, index, headers)
                        if items:
                            return items
                    if {"컷번호", "시작시간"} <= headers.keys() and (
                        "길이(초)" in headers
                        or "길이초" in headers
                        or "종료시간" in headers
                    ):
                        items = _parse_legacy_xlsx(rows, index, headers)
                        if items:
                            return items
    except (KeyError, OSError, zipfile.BadZipFile, ElementTree.ParseError) as exc:
        raise StoryboardValidationError(
            f"Invalid or unreadable XLSX file: {path}"
        ) from exc
    raise StoryboardValidationError(
        "XLSX에서 지원되는 머리글을 찾지 못했습니다. "
        "file_name/start_time 또는 컷 번호/시작 시간/길이(초)가 필요합니다."
    )


def parse_storyboard_file(storyboard_path: Path) -> list[StoryboardItem]:
    """Dispatch a storyboard path to the CSV or XLSX parser by extension."""

    path = storyboard_path.expanduser().resolve()
    suffix = path.suffix.casefold()
    if suffix not in SUPPORTED_STORYBOARD_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_STORYBOARD_EXTENSIONS))
        raise StoryboardValidationError(
            f"Unsupported storyboard format {suffix or '(none)'}. Use: {supported}"
        )
    return parse_storyboard(path) if suffix == ".csv" else parse_xlsx_storyboard(path)


def resolve_media_files(
    items: Iterable[StoryboardItem], media_root: Path
) -> list[ResolvedStoryboardItem]:
    """Resolve storyboard file names against ``media_root`` recursively.

    Names with extensions first try the exact relative path, then a basename
    lookup. Extensionless names match by stem. Ambiguous and missing matches are
    reported together.
    """

    root = media_root.expanduser().resolve()
    if not root.is_dir():
        raise StoryboardValidationError(f"Media directory does not exist: {root}")

    storyboard_items = list(items)
    requested_names = {
        Path(item.file_name).name.casefold()
        for item in storyboard_items
        if Path(item.file_name).suffix
    }
    requested_stems = {
        Path(item.file_name).stem.casefold()
        for item in storyboard_items
        if not Path(item.file_name).suffix
    }
    by_name: dict[str, list[Path]] = defaultdict(list)
    by_stem: dict[str, list[Path]] = defaultdict(list)
    by_take: dict[str, list[tuple[int, Path]]] = defaultdict(list)
    for candidate in root.rglob("*"):
        if not candidate.is_file() or candidate.suffix.casefold() not in SUPPORTED_MEDIA_EXTENSIONS:
            continue
        name = candidate.name.casefold()
        stem = candidate.stem.casefold()
        if name in requested_names:
            by_name[name].append(candidate.resolve())
        if stem in requested_stems:
            by_stem[stem].append(candidate.resolve())
        base, separator, take_text = stem.rpartition("-")
        if separator and base in requested_stems and take_text.isdigit():
            by_take[base].append((int(take_text), candidate.resolve()))

    resolved: list[ResolvedStoryboardItem] = []
    errors: list[str] = []
    for item in storyboard_items:
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
            candidates = sorted(
                lookup.get(key, []), key=lambda path: path.as_posix().casefold()
            )

        if not candidates and not requested.suffix:
            take_matches = by_take.get(requested.stem.casefold(), [])
            if take_matches:
                highest_take = max(take for take, _path in take_matches)
                candidates = sorted(
                    (
                        path
                        for take, path in take_matches
                        if take == highest_take
                    ),
                    key=lambda path: path.as_posix().casefold(),
                )
                if len(candidates) == 1:
                    LOGGER.info(
                        "Row %d: exact media %r not found; using take %s",
                        item.source_row,
                        item.file_name,
                        candidates[0].name,
                    )

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
