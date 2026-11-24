#!/usr/bin/env bash
# Prepares a server to run systems of the platform.
#
# Run as root, once per server. Running it again changes nothing that is already in place.
# It needs Docker Engine with the Compose plugin already installed, and creates only:
#   - the service user `platform`, member of the `docker` group
#   - /srv/platform, closed to every other user
#   - one private Docker network per environment
#   - a GitHub Actions runner registered to the platform repository, as a systemd service
# It opens no port and changes nothing it did not create.
#
#   sudo REPO_URL=https://github.com/<organization>/<platform-repository> ./bootstrap.sh
#
# The runner registration token is asked for on the terminal (or read from RUNNER_TOKEN).
# Get one at: repository Settings > Actions > Runners > New self-hosted runner. It lasts one hour.

set -euo pipefail

PLATFORM_ROOT="/srv/platform"
PLATFORM_USER="platform"
ENVIRONMENTS=(staging production)
RUNNER_LABELS="${RUNNER_LABELS:-staging,production}"

# Version installed on first run. The runner keeps itself up to date afterwards.
RUNNER_VERSION="2.338.2"
RUNNER_SHA256_X64="baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40"
RUNNER_SHA256_ARM64="670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
as_platform() { runuser -u "$PLATFORM_USER" -- "$@"; }

# --- Preflight: stop before changing anything if the server is not what this script expects.

[ "$(id -u)" -eq 0 ] || die "run as root"
[ "$(uname -s)" = "Linux" ] || die "Linux only"
for tool in docker curl tar sha256sum runuser systemctl useradd; do
  command -v "$tool" >/dev/null || die "missing required command: $tool"
done
docker info >/dev/null 2>&1 || die "Docker is not running"
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is not installed"
getent group docker >/dev/null || die "group 'docker' does not exist"

case "$(uname -m)" in
  x86_64) runner_arch="x64"; runner_sha="$RUNNER_SHA256_X64" ;;
  aarch64) runner_arch="arm64"; runner_sha="$RUNNER_SHA256_ARM64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ -e "$PLATFORM_ROOT" ] && ! id "$PLATFORM_USER" >/dev/null 2>&1; then
  die "$PLATFORM_ROOT exists but user '$PLATFORM_USER' does not; not touching a directory this script did not create"
fi
if [ -e "$PLATFORM_ROOT" ] && [ "$(stat -c %U "$PLATFORM_ROOT")" != "$PLATFORM_USER" ]; then
  die "$PLATFORM_ROOT is not owned by '$PLATFORM_USER'"
fi

runner_dir="$PLATFORM_ROOT/runner"
if [ ! -e "$runner_dir/.runner" ]; then
  [ -n "${REPO_URL:-}" ] || die "set REPO_URL to the platform repository, e.g. https://github.com/<organization>/<repository>"
  case "$REPO_URL" in
    https://github.com/*/*) ;;
    *) die "REPO_URL must look like https://github.com/<organization>/<repository>" ;;
  esac
  if [ -z "${RUNNER_TOKEN:-}" ]; then
    [ -t 0 ] || die "RUNNER_TOKEN is not set and there is no terminal to ask for it"
    read -r -s -p "Runner registration token: " RUNNER_TOKEN
    printf '\n'
  fi
  [ -n "$RUNNER_TOKEN" ] || die "empty registration token"
fi

# --- Service user and directories.

if ! id "$PLATFORM_USER" >/dev/null 2>&1; then
  say "Creating user $PLATFORM_USER"
  useradd --system --create-home --home-dir "$PLATFORM_ROOT" --shell /usr/sbin/nologin "$PLATFORM_USER"
fi
# Membership of the docker group is equivalent to root on this server. That is what a deploy
# needs, and it is why only platform administrators can write to the platform repository.
usermod --append --groups docker "$PLATFORM_USER"

install -d -m 0700 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$PLATFORM_ROOT" "$runner_dir"
for environment in "${ENVIRONMENTS[@]}"; do
  install -d -m 0700 -o "$PLATFORM_USER" -g "$PLATFORM_USER" "$PLATFORM_ROOT/$environment"
done

# Key used to identify releases without revealing anything about their configuration.
if [ ! -e "$PLATFORM_ROOT/release.key" ]; then
  say "Creating the release key"
  (umask 077 && head -c 32 /dev/urandom > "$PLATFORM_ROOT/release.key")
  chown "$PLATFORM_USER:$PLATFORM_USER" "$PLATFORM_ROOT/release.key"
fi

# --- One network per environment. Systems of staging and production never share a network.

for environment in "${ENVIRONMENTS[@]}"; do
  network="platform_$environment"
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    say "Creating network $network"
    docker network create --label platform.managed=true "$network" >/dev/null
  fi
done

# --- Runner: connects outbound to GitHub and runs the deploy workflow of one repository.

if [ -e "$runner_dir/.runner" ]; then
  say "Runner already registered; leaving it as it is"
else
  archive="actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz"
  download="$(mktemp -d)"
  trap 'rm -rf "$download"' EXIT
  say "Downloading runner $RUNNER_VERSION"
  curl --fail --silent --show-error --location \
    --output "$download/$archive" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${archive}"
  printf '%s  %s\n' "$runner_sha" "$download/$archive" | sha256sum --check --quiet \
    || die "runner archive does not match the expected checksum"
  tar --extract --gzip --file "$download/$archive" --directory "$runner_dir"
  chown -R "$PLATFORM_USER:$PLATFORM_USER" "$runner_dir"

  say "Installing the runner's system libraries"
  "$runner_dir/bin/installdependencies.sh" >/dev/null

  say "Registering the runner with $REPO_URL"
  # The token goes through the environment, not the command line, so it never shows in `ps`.
  (
    cd "$runner_dir"
    export HOME="$PLATFORM_ROOT"
    export ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN"
    as_platform ./config.sh --unattended --replace \
      --url "$REPO_URL" --name "$(hostname)" --labels "$RUNNER_LABELS"
  )
  unset RUNNER_TOKEN

  say "Installing the runner as a service"
  (cd "$runner_dir" && ./svc.sh install "$PLATFORM_USER" >/dev/null && ./svc.sh start >/dev/null)
fi

# --- Report.

say "Done"
printf '    user:      %s (groups: %s)\n' "$PLATFORM_USER" "$(id -nG "$PLATFORM_USER")"
printf '    directory: %s\n' "$PLATFORM_ROOT"
printf '    networks:  %s\n' "$(docker network ls --filter label=platform.managed=true --format '{{.Name}}' | sort | paste -sd' ')"
printf '    runner:    %s\n' "$(cd "$runner_dir" && ./svc.sh status 2>/dev/null | grep -m1 -E 'Active:|active|inactive' | sed 's/^ *//' || echo 'see: systemctl list-units "actions.runner.*"')"
