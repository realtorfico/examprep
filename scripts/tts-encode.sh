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
else
  FFMPEG="$(find "$HOME/.cache/passexamhq-tools/ffmpeg" -name 'ffmpeg.exe' -type f 2>/dev/null | head -1)"
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
