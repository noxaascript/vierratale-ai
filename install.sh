#!/usr/bin/env bash
#
# VierrataleAI Installer
# ----------------------
# Sets up the requirements for running VierrataleAI from this workspace:
#   - the local AI engine (Cortex)
#   - the model
#   - the runtime (Node.js or Python) and curl
#   - the "vierrataleai" / "vierratale" commands on your PATH
#
# It does NOT re-install the app from npm or PyPI: this repo is the app. It
# only installs dependencies and links commands that launch the assistant.
#
# Usage:
#   ./install.sh                Interactive (asks "NodeJS or Python? [N/P]")
#   ./install.sh --node         Use the Node.js version
#   ./install.sh --python       Use the Python version
#   ./install.sh --no-engine    Skip Engine / model installation
#   ./install.sh --coding       Also pull the coding model (VTL-3.3-Pro)
#   ./install.sh --model NAME   Model to pull (default: VTL-2.7-Flash)
#   ./install.sh --silent       Everything with defaults, no prompts
#   ./install.sh --uninstall    Remove the commands + config
#   ./install.sh --help         Show this help
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Branding / constants
# ---------------------------------------------------------------------------
PURPLE='\033[38;2;124;58;237m'
CYAN='\033[38;2;6;182;212m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

VERSION="1.0.0"
INSTALLER_NAME="VierrataleAI Installer"
DEFAULT_MODEL="VTL-2.7-Flash"
CODING_MODEL="VTL-3.3-Pro"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$XDG_CONFIG_HOME/vierrataleai"
CONFIG_FILE="$CONFIG_DIR/config.json"
INSTALL_LOG="$CONFIG_DIR/install.log"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE=""            # node | python
INSTALL_ENGINE=1   # 1 = yes, 0 = no
INSTALL_CODING=0   # 1 = yes, 0 = no (coding model)
SILENT=0
UNINSTALL=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()  { printf "${CYAN}▸${RESET} %b\n" "$*"; }
ok()    { printf "${GREEN}✔${RESET} %b\n" "$*"; }
warn()  { printf "${YELLOW}⚠${RESET} %b\n" "$*"; }
err()   { printf "${RED}✖ %b${RESET}\n" "$*"; }

banner() {
  cat <<'EOF'

               _
  _   _ _                      / \ _______
 | | | |                      / _ \\_  _ /
 | | | |_  ___ _ __ _ __ __ _/ /_\ \ | |  
 | | | | |/ _ \ '__| '__/ _` |  _  | | |  
 \ \_/ / |  __/ |  | | | (_| | | | |_| |_ 
  \___/|_|\___|_|  |_|  \__,_|_| |_/\___/ 
EOF
  printf "${BOLD}${PURPLE}▸ ${INSTALLER_NAME}${RESET} ${DIM}v${VERSION}${RESET}\n\n"
}

log()  { mkdir -p "$CONFIG_DIR" 2>/dev/null; printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$INSTALL_LOG" 2>/dev/null || true; }

cmd_exists() { command -v "$1" >/dev/null 2>&1; }

need() { # need <cmd> <hint>
  if ! cmd_exists "$1"; then
    err "Missing required tool: $1"
    info "Hint: $2"
    exit 1
  fi
}

# Silent runner with spinner: run_spinner "<message>" <cmd...>
run_spinner() {
  local msg="$1"; shift
  local spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0 pid=""
  printf "${DIM}%s... ${RESET}" "$msg"
  "$@" >/dev/null 2>&1 & pid=$!
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf "\b${CYAN}%s${RESET}" "${spin:i++%${#spin}:1}"
      sleep 0.1
    done
  fi
  wait "$pid" || true
  [ -t 1 ] && printf "\b"
  printf "${GREEN}✔${RESET}\n"
}

prompt_yes_no() {
  local default="${2:-y}" ans
  [ "$SILENT" = "1" ] && { [ "$default" = "y" ] && return 0 || return 1; }
  while true; do
    read -r -p "$(printf "${DIM}%s [${default}]${RESET} " "$1")" ans
    ans="${ans:-$default}"
    case "$ans" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
      *) printf "  ${DIM}Please answer y or n.${RESET}\n" ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
detect_platform() {
  if [ -n "${TERMUX_VERSION:-}" ] || [ -d "/data/data/com.termux" ]; then
    PLATFORM="termux"
  elif [ -f "/proc/version" ] && grep -qi microsoft /proc/version 2>/dev/null; then
    PLATFORM="wsl"
  elif [ "$(uname -s)" = "Darwin" ]; then
    PLATFORM="macos"
  else
    PLATFORM="linux"
  fi
  log "Platform detected: $PLATFORM"
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
  banner
  info "Uninstalling VierrataleAI..."
  for name in vierrataleai vierratale; do
    rm -f "$HOME/.local/bin/$name" /usr/local/bin/$name /usr/bin/$name
  done
  if [ -d "$CONFIG_DIR" ]; then
    info "Removing config and conversation history..."
    rm -rf "$CONFIG_DIR"
  fi
  ok "VierrataleAI removed. The underlying engine binary was left untouched."
}

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
package_install() { # issue a package-manager install for the current platform
  local what="$1"
  info "Installing $what..."
  case "$PLATFORM" in
    termux) pkg install -y "$what" >> "$INSTALL_LOG" 2>&1 ;;
    macos)
      if cmd_exists brew; then brew install "$what" >> "$INSTALL_LOG" 2>&1; fi
      ;;
    *)
      if cmd_exists apt-get; then
        apt-get update >> "$INSTALL_LOG" 2>&1
        apt-get install -y "$what" >> "$INSTALL_LOG" 2>&1
      elif cmd_exists dnf; then
        dnf install -y "$what" >> "$INSTALL_LOG" 2>&1
      elif cmd_exists pacman; then
        pacman -S --noconfirm --needed "$what" >> "$INSTALL_LOG" 2>&1
      fi
      ;;
  esac
}

# The first python that can actually run the app (has the 'rich' library).
pick_python() {
  if cmd_exists python3 && python3 -c 'import rich' >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  for py in /data/data/com.termux/files/usr/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$py" ] && "$py" -c 'import rich' >/dev/null 2>&1; then
      printf "%s" "$py"
      return 0
    fi
  done
  if cmd_exists python3; then
    command -v python3
  else
    printf "/usr/bin/python3"
  fi
}

install_runtime() {
  case "$MODE" in
    node)
      if cmd_exists node; then
        ok "Node.js found: $(node -v)"
      else
        package_install nodejs
        need node "Install nodejs (≥18), then re-run this installer."
        ok "Node.js installed: $(node -v)"
      fi
      ;;
    python)
      if cmd_exists python3; then
        ok "Python found: $(python3 -V)"
      else
        package_install python3
        need python3 "Install Python 3, then re-run this installer."
        ok "Python installed: $(python3 -V)"
      fi
      MODE_PYTHON="$(pick_python)"
      if ! "$MODE_PYTHON" -c 'import rich' >/dev/null 2>&1; then
        warn "Python 'rich' library is missing."
        if "$MODE_PYTHON" -m pip install --user rich >> "$INSTALL_LOG" 2>&1; then
          ok "rich installed for $MODE_PYTHON."
        else
          err "Could not install 'rich'. Run: $MODE_PYTHON -m pip install --user rich"
          exit 1
        fi
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Command linking (this repo IS the app; we just place launchers on PATH)
# ---------------------------------------------------------------------------
is_on_path() {
  local d="$1" p
  for p in ${PATH//:/ }; do
    [ "$p" = "$d" ] && return 0
  done
  return 1
}

command_bin_dir() {
  mkdir -p "$HOME/.local/bin"
  local localbin="$HOME/.local/bin"
  if is_on_path "$localbin"; then
    printf "%s" "$localbin"
    return 0
  fi
  for d in /usr/local/bin /usr/bin; do
    if [ -d "$d" ] && [ -w "$d" ]; then
      printf "%s" "$d"
      return 0
    fi
  done
  printf "%s" "$localbin"
}

link_commands() {
  info "Linking the vierrataleai / vierratale commands..."
  local bin
  bin="$(command_bin_dir)"
  case "$MODE" in
    node)
      local target="$ROOT/nodejs/bin/vierrataleai.js"
      chmod +x "$target"
      ln -sf "$target" "$bin/vierrataleai"
      ln -sf "$target" "$bin/vierratale"
      ;;
    python)
      local py
      py="${MODE_PYTHON:-$(command -v python3)}"
      for name in vierrataleai vierratale; do
        # Unlink first: never overwrite through a symlink (that could clobber
        # the real bin script in this repo).
        rm -f "$bin/$name"
        cat > "$bin/$name" <<EOF
#!/bin/sh
PYTHONPATH="$ROOT/python" exec $py -m vierrataleai "\$@"
EOF
        chmod +x "$bin/$name"
      done
      ;;
  esac
  ok "Commands linked: $bin/vierrataleai and $bin/vierratale"
  if ! is_on_path "$bin" && [ "$bin" != "/usr/local/bin" ] && [ "$bin" != "/usr/bin" ]; then
    warn 'Add to your PATH, e.g.: export PATH="$HOME/.local/bin:$PATH"'
  fi
}

# ---------------------------------------------------------------------------
# Cortex Engine + model
# ---------------------------------------------------------------------------
is_engine_installed() {
  cmd_exists ollama || [ -x /usr/local/bin/ollama ] || [ -x /usr/bin/ollama ]
}

is_engine_running() {
  curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1
}

install_engine() {
  if is_engine_installed; then
    ok "Cortex Engine already installed."
  else
    info "Installing Cortex Engine..."
    run_spinner "Installing Cortex Engine" bash -c 'curl -fsSL https://ollama.com/install.sh | sh'
    if ! is_engine_installed; then
      warn "Cortex Engine install failed. Run the installer again to retry."
    else
      ok "Cortex Engine installed."
    fi
  fi

  if ! is_engine_running; then
    info "Starting Cortex Engine..."
    nohup ollama serve >> "$INSTALL_LOG" 2>&1 &
    for _ in $(seq 1 15); do
      is_engine_running && break
      sleep 1
    done
  fi
  is_engine_running && ok "Cortex Engine is running." || warn "Cortex Engine is not responding yet."
}

pull_model() {
  local model="$1" real
  # Real model names must match the app catalog (catalog.js / vierrataleai/catalog.py).
  case "$model" in
    VTL-2.7-Flash)     real="gemma3:1b" ;;
    VTL-2.9-Core)      real="llama3.2:1b" ;;
    VTL-3.1-Plus)      real="qwen2.5:1.5b" ;;
    VTL-3.3-Pro)       real="qwen2.5-coder:1.5b" ;;
    VTL-3.5-Reason)    real="qwen3:1.7b" ;;
    vierratale-fast)     real="gemma3:1b" ;;
    vierratale-small)    real="llama3.2:1b" ;;
    vierratale-balanced) real="qwen2.5:1.5b" ;;
    vierratale-plus)     real="qwen3:1.7b" ;;
    *)                   real="$model" ;;
  esac
  is_engine_installed || { warn "Engine binary not found; re-run this installer after installing it."; return 1; }
  info "Pulling model '$model' — first download can take a while..."
  if [ "$SILENT" = "1" ]; then
    if ollama pull "$real" >> "$INSTALL_LOG" 2>&1; then
      ok "Model '$model' is ready."
    else
      warn "Could not pull '$model'. Run the installer again to retry."
      return 1
    fi
  else
    if ollama pull "$real"; then
      ok "Model '$model' is ready."
    else
      warn "Could not pull '$model'. Run the installer again to retry."
      return 1
    fi
  fi
}

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
write_config() {
  mkdir -p "$CONFIG_DIR"
  touch "$INSTALL_LOG"
  if [ ! -f "$CONFIG_FILE" ]; then
    cat > "$CONFIG_FILE" <<EOF
{
  "provider": "$1",
  "model": "$2",
  "engineHost": "http://127.0.0.1:11434",
  "numCtx": 8192,
  "temperature": 0.7,
  "maxTokens": 4096
}
EOF
    log "Wrote config provider=$1 model=$2"
  else
    log "Config already exists; leaving untouched."
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  detect_platform
  banner

  # Ensure the config + log directory exists before any logging.
  mkdir -p "$CONFIG_DIR"
  touch "$INSTALL_LOG"

  if [ "$UNINSTALL" = "1" ]; then
    do_uninstall
    exit 0
  fi

  # curl is required for the engine install.
  need curl "Install curl (e.g. apt-get install -y curl), then re-run this installer."

  # --- Pick mode ---
  if [ -z "$MODE" ]; then
    if [ "$SILENT" = "1" ]; then
      cmd_exists python3 && MODE="python" || MODE="node"
    else
      while true; do
        read -r -p "$(printf "${DIM}NodeJS or Python? [N/P] ${RESET}")" choice
        case "${choice:-P}" in
          [Nn]*) MODE="node" ; break ;;
          [Pp]*) MODE="python" ; break ;;
          *) printf "  ${DIM}Please answer N or P.${RESET}\n" ;;
        esac
      done
    fi
  fi

  # --- Ask about Cortex Engine (interactive only) ---
  if [ "$INSTALL_ENGINE" = "1" ] && [ "$SILENT" != "1" ]; then
    printf "\n${BOLD}Install Cortex Engine and a local AI model?${RESET}\n"
    info "Downloads ~1GB and needs a few GB of memory for offline AI."
    if ! prompt_yes_no "Install Cortex Engine + model?" "y"; then
      INSTALL_ENGINE=0
    fi
  fi

  # --- Ask about coding model (interactive only) ---
  if [ "$SILENT" != "1" ]; then
    printf "\n${BOLD}Do you want coding support?${RESET}\n"
    info "Installs a code-specialized model (${CODING_MODEL}) alongside the default."
    if prompt_yes_no "Install coding model?" "y"; then
      INSTALL_CODING=1
    fi
  fi

  # --- Runtime prerequisites ---
  printf "\n${BOLD}Installing prerequisites...${RESET}\n"
  install_runtime

  # --- Remove the unchosen runtime directory ---
  case "$MODE" in
    node)
      if [ -d "$ROOT/python" ]; then
        rm -rf "$ROOT/python"
        info "Python source removed (NodeJS chosen)."
      fi
      ;;
    python)
      if [ -d "$ROOT/nodejs" ]; then
        rm -rf "$ROOT/nodejs"
        info "NodeJS source removed (Python chosen)."
      fi
      ;;
  esac

  # --- Cortex Engine ---
  if [ "$INSTALL_ENGINE" = "1" ]; then
    printf "\n${BOLD}Setting up the local AI engine (Cortex)...${RESET}\n"
    install_engine
    if is_engine_installed; then
      pull_model "$DEFAULT_MODEL"
      if [ "$INSTALL_CODING" = "1" ]; then
        pull_model "$CODING_MODEL"
      fi
      write_config cortex "$DEFAULT_MODEL"
    else
      write_config auto "$DEFAULT_MODEL"
    fi
  else
    write_config auto "$DEFAULT_MODEL"
  fi

  # --- Link the commands ---
  link_commands

  # --- Summary ---
  printf "\n${GREEN}──────────────────────────────────────────────${RESET}\n"
  ok "${BOLD}VierrataleAI installed successfully!${RESET}"
  if cmd_exists vierrataleai || cmd_exists vierratale; then
    info "Start it with: ${CYAN}vierrataleai${RESET} (or ${CYAN}vierratale${RESET})"
  else
    case "$MODE" in
      node)   info "Start it with: ${CYAN}node $ROOT/nodejs/bin/vierrataleai.js${RESET}" ;;
      python) info "Start it with: ${CYAN}PYTHONPATH=$ROOT/python ${MODE_PYTHON:-python3} -m vierrataleai${RESET}" ;;
    esac
  fi
  info "Config: ${DIM}$CONFIG_FILE${RESET}"
  if [ "$INSTALL_ENGINE" = "1" ] && is_engine_installed; then
    info "Local engine (Cortex) + model ${CYAN}$DEFAULT_MODEL${RESET} ready."
    if [ "$INSTALL_CODING" = "1" ]; then
      info "Coding model ${CYAN}$CODING_MODEL${RESET} ready."
    fi
  else
    info "Tip: re-run with ${CYAN}--engine${RESET} style flags to customize."
  fi
  printf "${GREEN}──────────────────────────────────────────────${RESET}\n"
  log "Install complete (mode=$MODE engine=$INSTALL_ENGINE model=$DEFAULT_MODEL)"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --node)      MODE="node" ;;
    --python)    MODE="python" ;;
    --no-engine) INSTALL_ENGINE=0 ;;
    --coding)    INSTALL_CODING=1 ;;
    --model)     shift; DEFAULT_MODEL="$1" ;;
    --silent)    SILENT=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h)
      sed -n '3,17p' "$0" | sed 's/^# //; s/^#//'
      exit 0
      ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

main "$@"