"""Command-line entry point for the Premiere storyboard builder."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path
from typing import Sequence

from config import BuildConfig, DEFAULT_BIN_NAME, DEFAULT_JSX_NAME
from csv_parser import (
    StoryboardValidationError,
    parse_storyboard_file,
    resolve_media_files,
)
from premiere_builder import PremiereBuildError, execute_jsx, write_jsx

LOGGER = logging.getLogger(__name__)


def build_argument_parser() -> argparse.ArgumentParser:
    """Create the CLI parser."""

    parser = argparse.ArgumentParser(
        description="Import CSV/XLSX storyboard media and arrange it in Premiere Pro."
    )
    parser.add_argument("storyboard", type=Path, help="Storyboard CSV or XLSX path")
    parser.add_argument("--media-root", required=True, type=Path, help="Media root folder")
    parser.add_argument("--project", required=True, type=Path, help="Target .prproj file")
    parser.add_argument(
        "--sequence", help="Sequence name (defaults to Premiere's active sequence)"
    )
    parser.add_argument(
        "--output-jsx", type=Path, default=Path(DEFAULT_JSX_NAME), help="Generated JSX path"
    )
    parser.add_argument("--bin-name", default=DEFAULT_BIN_NAME, help="Import bin name")
    parser.add_argument(
        "--no-audio", action="store_true", help="Place video only, without source audio"
    )
    parser.add_argument(
        "--no-save", action="store_true", help="Do not save the Premiere project after placement"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate and generate JSX without executing it"
    )
    parser.add_argument("--verbose", action="store_true", help="Enable debug logging")
    return parser


def _validate_project(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if not resolved.is_file():
        raise StoryboardValidationError(f"Premiere project does not exist: {resolved}")
    if resolved.suffix.casefold() != ".prproj":
        raise StoryboardValidationError(f"Project must be a .prproj file: {resolved}")
    return resolved


def run(argv: Sequence[str] | None = None) -> int:
    """Run the pipeline and return a process exit code."""

    args = build_argument_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )

    try:
        project_path = _validate_project(args.project)
        storyboard = parse_storyboard_file(args.storyboard)
        resolved_items = resolve_media_files(storyboard, args.media_root)
        config = BuildConfig(
            storyboard_path=args.storyboard.expanduser().resolve(),
            media_root=args.media_root.expanduser().resolve(),
            project_path=project_path,
            sequence_name=args.sequence,
            output_jsx=args.output_jsx,
            bin_name=args.bin_name,
            place_audio=not args.no_audio,
            save_project=not args.no_save,
        )
        jsx_path = write_jsx(config, resolved_items)
        if args.dry_run:
            LOGGER.info("Dry run complete: %d row(s) validated", len(resolved_items))
            return 0

        result = execute_jsx(jsx_path)
        LOGGER.info(
            "Completed: placed=%d imported=%d sequence=%s",
            result.placed,
            result.imported,
            result.sequence_name,
        )
        return 0
    except (StoryboardValidationError, PremiereBuildError) as exc:
        LOGGER.error("%s", exc)
        return 2
    except Exception:
        LOGGER.exception("Unexpected failure")
        return 1


if __name__ == "__main__":
    sys.exit(run())
