"""Generate and execute a Premiere Pro ExtendScript storyboard build."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from config import BuildConfig, ResolvedStoryboardItem

LOGGER = logging.getLogger(__name__)


class PremiereBuildError(RuntimeError):
    """Raised when JSX generation or Premiere execution fails."""


@dataclass(frozen=True, slots=True)
class BuildResult:
    """Summary returned by the generated ExtendScript."""

    placed: int
    imported: int
    skipped: int
    sequence_name: str
    jsx_path: Path


def _jsx_string(value: str) -> str:
    """Create a JSX string expression without slash escaping.

    Pymiere escapes every backslash before transport. Expressing strings as
    UTF-16 code units keeps Windows paths, quotes, and Unicode names intact.
    """

    utf16 = value.encode("utf-16-le")
    units = [utf16[index] | (utf16[index + 1] << 8) for index in range(0, len(utf16), 2)]
    if not units:
        return '""'
    return "String.fromCharCode(" + ",".join(str(unit) for unit in units) + ")"


def _optional_jsx_string(value: str | None) -> str:
    return "null" if value is None else _jsx_string(value)


def _format_number(value: float) -> str:
    return format(value, ".15g")


def _items_javascript(items: Sequence[ResolvedStoryboardItem]) -> str:
    rows: list[str] = []
    for item in items:
        duration = "null" if item.duration is None else _format_number(item.duration)
        rows.append(
            "{path:%s,start:%s,duration:%s,track:%d,row:%d}"
            % (
                _jsx_string(item.media_path.resolve().as_posix()),
                _format_number(item.start_time),
                duration,
                item.track_index - 1,
                item.source_row,
            )
        )
    return "[" + ",".join(rows) + "]"


def generate_jsx(
    config: BuildConfig, items: Sequence[ResolvedStoryboardItem]
) -> str:
    """Return a self-contained ExtendScript program for the given storyboard."""

    project_path = config.project_path.expanduser().resolve().as_posix()
    script = f"""(function () {{
    var projectPath = {_jsx_string(project_path)};
    var sequenceName = {_optional_jsx_string(config.sequence_name)};
    var binName = {_jsx_string(config.bin_name)};
    var placeAudio = {str(config.place_audio).lower()};
    var saveProject = {str(config.save_project).lower()};
    var rows = {_items_javascript(items)};
    var slash = String.fromCharCode(92);
    var isWindows = $.os.toLowerCase().indexOf("windows") >= 0;
    var importedCount = 0;
    var placedCount = 0;
    var skippedCount = 0;
    var itemCache = {{}};
    var targetBin = null;

    function normalizedPath(value) {{
        var result = String(value || "").split(slash).join("/");
        return isWindows ? result.toLowerCase() : result;
    }}

    function samePath(left, right) {{
        return normalizedPath(left) === normalizedPath(right);
    }}

    function findItemByPath(parent, wantedPath) {{
        if (!parent || !parent.children) {{ return null; }}
        for (var i = 0; i < parent.children.numItems; i++) {{
            var child = parent.children[i];
            try {{
                if (child.getMediaPath && samePath(child.getMediaPath(), wantedPath)) {{
                    return child;
                }}
            }} catch (ignoredMediaPathError) {{}}
            if (child.children) {{
                var nested = findItemByPath(child, wantedPath);
                if (nested) {{ return nested; }}
            }}
        }}
        return null;
    }}

    function getOrImportItem(project, row) {{
        var cacheKey = "$" + normalizedPath(row.path);
        if (Object.prototype.hasOwnProperty.call(itemCache, cacheKey)) {{
            return itemCache[cacheKey];
        }}
        var item = findItemByPath(project.rootItem, row.path);
        if (!item) {{
            if (!targetBin) {{ targetBin = getOrCreateBin(project.rootItem, binName); }}
            if (!project.importFiles([row.path], true, targetBin, false)) {{
                throw new Error("Import failed for storyboard row " + row.row + ": " + row.path);
            }}
            importedCount++;
            item = findItemByPath(project.rootItem, row.path);
            if (!item) {{
                throw new Error("Imported item could not be located: " + row.path);
            }}
        }}
        itemCache[cacheKey] = item;
        return item;
    }}

    function getOrCreateBin(root, wantedName) {{
        for (var i = 0; i < root.children.numItems; i++) {{
            var child = root.children[i];
            if (child.name === wantedName && child.children) {{ return child; }}
        }}
        var created = root.createBin(wantedName);
        if (!created) {{ throw new Error("Could not create project bin: " + wantedName); }}
        return created;
    }}

    function getSequence(project, wantedName) {{
        if (!wantedName) {{
            if (!project.activeSequence) {{
                throw new Error("No active sequence. Open a sequence or pass --sequence.");
            }}
            return project.activeSequence;
        }}
        for (var i = 0; i < project.sequences.numSequences; i++) {{
            if (project.sequences[i].name === wantedName) {{
                project.openSequence(project.sequences[i].sequenceID);
                return project.sequences[i];
            }}
        }}
        throw new Error("Sequence not found: " + wantedName);
    }}

    function trimMatchingClips(track, item, start, duration) {{
        if (!track || duration === null) {{ return; }}
        var endTime = new Time();
        endTime.seconds = start + duration;
        for (var i = track.clips.numItems - 1; i >= 0; i--) {{
            var clip = track.clips[i];
            if (clip.projectItem && clip.projectItem.nodeId === item.nodeId &&
                    Math.abs(clip.start.seconds - start) < 0.02) {{
                clip.end = endTime;
                return;
            }}
        }}
    }}

    try {{
        if (!app.isDocumentOpen() || !samePath(app.project.path, projectPath)) {{
            if (!app.openDocument(projectPath)) {{
                throw new Error("Could not open project: " + projectPath);
            }}
        }}

        var project = app.project;
        var sequence = getSequence(project, sequenceName);

        for (var r = 0; r < rows.length; r++) {{
            var row = rows[r];
            if (row.track < 0 || row.track >= sequence.videoTracks.numTracks) {{
                skippedCount++;
                continue;
            }}

            try {{
                var item = getOrImportItem(project, row);
                var audioTrack = -1;
                if (placeAudio && sequence.audioTracks.numTracks > 0) {{
                    audioTrack = Math.min(row.track, sequence.audioTracks.numTracks - 1);
                    sequence.overwriteClip(item, row.start, row.track, audioTrack);
                }} else {{
                    var startTime = new Time();
                    startTime.seconds = row.start;
                    sequence.videoTracks[row.track].overwriteClip(item, startTime.ticks);
                }}
            }} catch (rowError) {{
                skippedCount++;
                $.writeln("Storyboard row " + row.row + " skipped: " + rowError);
                continue;
            }}

            placedCount++;
            try {{
                trimMatchingClips(sequence.videoTracks[row.track], item, row.start, row.duration);
                if (audioTrack >= 0) {{
                    trimMatchingClips(sequence.audioTracks[audioTrack], item, row.start, row.duration);
                }}
            }} catch (trimError) {{
                $.writeln("Storyboard row " + row.row + " trim warning: " + trimError);
            }}
        }}

        if (saveProject) {{ project.save(); }}
        return ["STORYBOARD_RESULT", "OK", placedCount, importedCount, skippedCount,
            sequence.name].join("|");
    }} catch (error) {{
        var message = String(error && error.message ? error.message : error);
        message = message.split("|").join("/");
        return ["STORYBOARD_RESULT", "ERROR", message].join("|");
    }}
}})();
"""
    return script


def write_jsx(
    config: BuildConfig, items: Sequence[ResolvedStoryboardItem]
) -> Path:
    """Generate JSX and write it as UTF-8, returning its absolute path."""

    output_path = config.output_jsx.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(generate_jsx(config, items), encoding="utf-8")
    LOGGER.info("Generated ExtendScript: %s", output_path)
    return output_path


def execute_jsx(jsx_path: Path) -> BuildResult:
    """Execute JSX through Pymiere Link and parse its result.

    Premiere Pro must already be running and the Pymiere Link CEP extension
    must be installed and reachable.
    """

    path = jsx_path.expanduser().resolve()
    if not path.is_file():
        raise PremiereBuildError(f"JSX file does not exist: {path}")

    try:
        from pymiere.core import eval_script  # type: ignore[import-not-found]
    except ImportError as exc:
        raise PremiereBuildError(
            "Pymiere is not installed. Run: python -m pip install -r requirements.txt"
        ) from exc

    try:
        response: Any = eval_script(filepath=str(path), decode_json=False)
    except Exception as exc:
        raise PremiereBuildError(
            "Could not execute JSX. Ensure Premiere Pro is running and Pymiere Link "
            "is installed/enabled."
        ) from exc

    text = str(response).strip()
    parts = text.split("|")
    if len(parts) < 2 or parts[0] != "STORYBOARD_RESULT":
        raise PremiereBuildError(f"Unexpected Premiere response: {text!r}")
    if parts[1] == "ERROR":
        raise PremiereBuildError(parts[2] if len(parts) > 2 else "Unknown JSX error")
    if len(parts) < 6 or parts[1] != "OK":
        raise PremiereBuildError(f"Malformed Premiere response: {text!r}")
    return BuildResult(
        placed=int(parts[2]),
        imported=int(parts[3]),
        skipped=int(parts[4]),
        sequence_name="|".join(parts[5:]),
        jsx_path=path,
    )
