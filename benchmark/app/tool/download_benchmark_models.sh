#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
models_dir="$root_dir/assets/models"
mkdir -p "$models_dir"

download_file() {
  local url="$1"
  local output="$2"
  mkdir -p "$(dirname "$output")"
  if [[ -s "$output" ]]; then
    echo "Using cached $output"
    return
  fi
  echo "Downloading $url"
  curl --fail --location --retry 5 --retry-delay 2 --connect-timeout 20 \
    --output "$output.tmp" "$url"
  mv "$output.tmp" "$output"
}

download_model() {
  local repo="$1"
  local onnx="$2"
  local base_url="https://huggingface.co/KittenML/${repo}/resolve/main"
  download_file "$base_url/$onnx" "$models_dir/$repo/$onnx"
  download_file "$base_url/voices.npz" "$models_dir/$repo/voices.npz"
}

download_model "kitten-tts-nano-0.8" "kitten_tts_nano_v0_8.onnx"
download_model "kitten-tts-nano-0.8-int8" "kitten_tts_nano_v0_8.onnx"
download_model "kitten-tts-micro-0.8" "kitten_tts_micro_v0_8.onnx"
download_model "kitten-tts-mini-0.8" "kitten_tts_mini_v0_8.onnx"

while IFS= read -r -d '' file; do
  ls -lh "$file"
done < <(find "$models_dir" -maxdepth 3 -type f ! -name ".gitkeep" -print0)
