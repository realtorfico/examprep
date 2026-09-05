#!/bin/bash
# Renders a narration script to a 96kbps/44.1kHz AAC .m4a, for the per-track audio resources that
# get uploaded to the examprep-media R2 bucket (see project_key_facts_digest_initiative memory).
#
# Windows SAPI (scripts/tts.ps1, "Microsoft Zira Desktop") -> WAV -> ffmpeg -> .m4a.
#
# Usage: tts-encode.sh <script.txt> <output-base-name> [output-dir]
#   e.g. tts-encode.sh mt_re_broker_script1.txt MT_Designated_Agent_Framework
#   Output base name should be the exact R2 object key minus the .m4a extension, since that key is
#   what the D1 `resources` row's `file` column has to match verbatim.
#
# Previously lived as a disposable copy in temp/ that was rewritten from scratch each session, and
# every copy hardcoded ONE shared scratch path (temp/_tts_tmp.wav) -- meaning two tracks rendering
# at the same time would silently stomp each other's WAV mid-encode. Promoted here and given a
# per-invocation mktemp dir so parallel per-track audio generation is actually safe (2026-09-05).
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $(basename "$0") <script.txt> <output-base-name> [output-dir]" >&2
  exit 2
fi

TXT="$1"
BASE="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# scripts -> passexamhq -> Websites -> PassExamHQ
OUT_DIR="${3:-$SCRIPT_DIR/../../../temp/audio_out}"

if [ ! -f "$TXT" ]; then
  echo "error: script file not found: $TXT" >&2
  exit 1
fi

# Prefer a real ffmpeg on PATH; otherwise fall back to the cached static win64 build that
# generate-qotd-video.js downloads on first run (this machine is Windows ARM64, where the usual
# npm ffmpeg packages don't work -- see root CLAUDE.md). Resolved by glob rather than a pinned
# version path so a cache refresh to a newer build doesn't silently break this script.
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG=ffmpeg
  FFPROBE=ffprobe
else
  FFMPEG="$(find "$HOME/.cache/passexamhq-tools/ffmpeg" -name 'ffmpeg.exe' -type f 2>/dev/null | head -1)"
  FFPROBE="$(find "$HOME/.cache/passexamhq-tools/ffmpeg" -name 'ffprobe.exe' -type f 2>/dev/null | head -1)"
  if [ -z "$FFMPEG" ]; then
    echo "error: no ffmpeg on PATH and none cached under ~/.cache/passexamhq-tools/ffmpeg" >&2
    echo "       run scripts/generate-qotd-video.js once to download it, or install ffmpeg." >&2
    exit 1
  fi
fi

# Per-invocation scratch dir -- the whole point of this rewrite. Cleaned up on any exit path
# (success, error, or interrupt) so parallel runs never see each other's leftovers.
WORK_DIR="$(mktemp -d -t tts-encode-XXXXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
WAV="$WORK_DIR/narration.wav"

mkdir -p "$OUT_DIR"
M4A="$OUT_DIR/${BASE}.m4a"

powershell.exe -NoProfile -File "$(cygpath -w "$SCRIPT_DIR/tts.ps1")" \
  -TextFile "$(cygpath -w "$TXT")" -OutFile "$(cygpath -w "$WAV")"

"$FFMPEG" -y -i "$WAV" -c:a aac -b:a 96k -ar 44100 "$M4A" 2>&1 | tail -3

echo "Built: $M4A ($(stat -c%s "$M4A") bytes)"

# Content sanity check: does the rendered audio actually match THIS script's length?
#
# Byte-comparing the local file against the uploaded R2 object (the check used throughout this
# project) proves the upload didn't corrupt anything -- it cannot tell you the local file was the
# wrong audio to begin with. That's not hypothetical: the shared-scratch-file bug this script was
# rewritten to fix produced a 149-second render for a 7-byte script, and every byte/Range check
# downstream passed it happily. Duration-vs-word-count is the cheap signal that actually catches it.
#
# ~2.5 words/sec is measured from this exact voice+rate (Zira Desktop, Rate=-1), not assumed.
# Bounds are deliberately loose -- this is a "did we render a completely different script" alarm,
# not a style check -- and it warns rather than failing, so a legitimately unusual script (heavy
# punctuation, long numerals) never blocks a build.
if [ -n "$FFPROBE" ]; then
  WORDS=$(wc -w < "$TXT")
  ACTUAL=$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$M4A" 2>/dev/null || echo 0)
  EXPECTED=$(awk "BEGIN{printf \"%.0f\", $WORDS / 2.5}")
  RATIO=$(awk "BEGIN{if ($EXPECTED>0) printf \"%.2f\", $ACTUAL / $EXPECTED; else print 0}")
  printf 'Duration check: %.0fs actual vs ~%ss expected for %s words (ratio %s)\n' "$ACTUAL" "$EXPECTED" "$WORDS" "$RATIO"
  if awk "BEGIN{exit !($RATIO < 0.6 || $RATIO > 1.7)}"; then
    echo "WARNING: duration is well outside the expected range for this script's length." >&2
    echo "         This is what a wrong-script render looks like -- listen before uploading." >&2
  fi
fi
