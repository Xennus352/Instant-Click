#!/usr/bin/env bash
# Download the pinned CPU ONNX releases and verify every selected file.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_CACHE_DIR="${MODEL_CACHE_DIR:-$ROOT/model_cache}"
HF_REVISION="${HF_REVISION:-main}"
usage() { echo "Usage: $0 download-all|download-sar|download-mini|verify"; }

download_repo_files() {
  local repo="$1" dest="$2" manifest="$3"
  mkdir -p "$dest"
  while read -r digest path; do
    [[ -n "${digest:-}" && "$digest" != \#* ]] || continue
    if command -v hf >/dev/null 2>&1; then
      hf download "$repo" "$path" --revision "$HF_REVISION" --local-dir "$dest"
    else
      echo "Install huggingface_hub CLI (`pip install huggingface_hub`) to download models." >&2
      return 2
    fi
  done < "$manifest"
  (cd "$dest" && sha256sum --check "$manifest")
}

verify_repo() {
  local dest="$1" manifest="$2"
  [[ -d "$dest" ]] || { echo "Missing model directory: $dest" >&2; return 1; }
  (cd "$dest" && sha256sum --check "$manifest")
  grep -q 'Apache License' "$dest/LICENSE" || { echo "Apache license text missing: $dest/LICENSE" >&2; return 1; }
  [[ -s "$dest/NOTICE" ]] || { echo "NOTICE missing: $dest/NOTICE" >&2; return 1; }
}

case "${1:-help}" in
  download-sar) download_repo_files YeeNyunn/nara-sar "$MODEL_CACHE_DIR/nara-sar" "$ROOT/scripts/nara-sar.sha256" ;;
  download-mini) download_repo_files YeeNyunn/nara-mini-v1 "$MODEL_CACHE_DIR/nara-mini-v1" "$ROOT/scripts/nara-mini-v1.sha256" ;;
  download-all)
    download_repo_files YeeNyunn/nara-sar "$MODEL_CACHE_DIR/nara-sar" "$ROOT/scripts/nara-sar.sha256"
    download_repo_files YeeNyunn/nara-mini-v1 "$MODEL_CACHE_DIR/nara-mini-v1" "$ROOT/scripts/nara-mini-v1.sha256" ;;
  verify)
    verify_repo "$MODEL_CACHE_DIR/nara-sar" "$ROOT/scripts/nara-sar.sha256"
    verify_repo "$MODEL_CACHE_DIR/nara-mini-v1" "$ROOT/scripts/nara-mini-v1.sha256" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
