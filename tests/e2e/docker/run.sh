#!/usr/bin/env bash
# Runs the Phase 0 gate (PLAN.md step 6) inside the pinned Linux container.
#
#   ./tests/e2e/docker/run.sh              # spike + host-fixture capture
#   ./tests/e2e/docker/run.sh <command>    # arbitrary command in the same image
#
# Everything is forced to linux/amd64 even on an arm64 host. Font rasterization
# differs between architectures, so baselines generated on an Apple Silicon
# developer machine would not match a CI runner's — and PLAN.md step 20 requires
# baselines to be container-generated and reproducible. One architecture, always;
# emulation is slower, but a fast baseline nobody else can reproduce is worthless.
set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
readonly DOCKER_DIR="${REPO_ROOT}/tests/e2e/docker"
readonly IMAGE_TAG="intelligit-e2e:pinned"
readonly PLATFORM="linux/amd64"

# The pin. Read from a checked-in file so it is reviewable in a diff and can be
# updated deliberately (see base-image.txt for how to re-resolve it).
readonly BASE_IMAGE="$(grep -v '^\s*#' "${DOCKER_DIR}/base-image.txt" | grep -v '^\s*$' | head -1)"
if [[ "${BASE_IMAGE}" != *"@sha256:"* ]]; then
    echo "base-image.txt must pin a digest (…@sha256:…), got: ${BASE_IMAGE}" >&2
    exit 1
fi

echo "==> base image: ${BASE_IMAGE}"
docker build \
    --platform="${PLATFORM}" \
    --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
    -f "${DOCKER_DIR}/Dockerfile" \
    -t "${IMAGE_TAG}" \
    "${DOCKER_DIR}"

# The pin claims amd64; this is what makes that claim falsifiable. Pixel
# baselines rasterize fonts differently per architecture, and an arm64 build
# would still pass every test here while producing baselines no CI runner can
# reproduce -- a diff full of antialiasing noise with nothing naming the cause.
BUILT_ARCH="$(docker image inspect --format '{{.Architecture}}' "${IMAGE_TAG}")"
if [[ "${BUILT_ARCH}" != "amd64" ]]; then
    echo "image built as ${BUILT_ARCH}, expected amd64 -- baselines from it are not reproducible" >&2
    exit 1
fi

# A named volume keeps the ~300MB VS Code download across runs. It is outside
# the bind-mounted repo, which the in-repo-cache guard requires anyway.
docker volume create intelligit-vscode-cache >/dev/null

# `node_modules` gets its OWN volume, deliberately. The repo is bind-mounted, so
# a container-side `bun install` would otherwise write Linux-x64 binaries
# straight over the host's macOS-arm64 ones — esbuild, and every other native
# dependency, are platform-specific. The host's next `bun run build` would then
# fail with an architecture mismatch that looks nothing like its cause. Keeping
# the directory in a volume means the two installs never see each other.
docker volume create intelligit-node-modules >/dev/null

# A TTY is right for an interactive developer run and fatal in CI, where there
# is none. Ask, rather than assume.
TTY_FLAGS=()
if [[ -t 0 && -t 1 ]]; then TTY_FLAGS=(-it); fi

# Default command: the two things step 6 gates on.
DEFAULT_CMD='bun install --frozen-lockfile \
  && bun run build \
  && xvfb-run -a npx playwright test --config=playwright.e2e.config.ts tests/e2e/spike/launch.spec.ts --reporter=list \
  && xvfb-run -a bun scripts/capture-host-fixtures.ts'

CMD="${*:-${DEFAULT_CMD}}"

# --ipc=host: Chromium/Electron exhaust the default 64MB /dev/shm and crash in
# ways that look like flaky tests rather than an OOM.
# --init: reaps the zombie processes a killed Electron leaves behind.
exec docker run --rm "${TTY_FLAGS[@]}" \
    --platform="${PLATFORM}" \
    --ipc=host \
    --init \
    -v "${REPO_ROOT}:/work" \
    -v intelligit-node-modules:/work/node_modules \
    -v intelligit-vscode-cache:/home/pwuser/.cache/intelligit-vscode-test \
    -w /work \
    "${IMAGE_TAG}" \
    bash -lc "${CMD}"
