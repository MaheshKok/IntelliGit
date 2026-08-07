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

# Everything the container writes outside the repo lives under one host-owned
# cache root, bind-mounted in.
#
# Named Docker volumes were the obvious choice here and are the wrong one. The
# container runs unprivileged (see the Dockerfile: Electron will not start its
# sandbox as root), and Docker creates a named volume owned by root:root, so the
# unprivileged user cannot write to it -- `bun install` fails with a bare
# `error: bun is unable to write files: AccessDenied` that names no path.
# Host directories created here are owned by the invoking user, which is the
# same identity the container is given below, so ownership lines up on both
# sides of every mount.
#
# `node_modules` is kept out of the repo for a second, independent reason: the
# repo is bind-mounted, so a container-side `bun install` would otherwise write
# Linux-x64 binaries straight over the host's macOS-arm64 ones -- esbuild and
# every other native dependency are platform-specific, and the host's next
# `bun run build` would fail with an architecture mismatch that looks nothing
# like its cause.
CACHE_ROOT="${INTELLIGIT_CONTAINER_CACHE:-${HOME}/.cache/intelligit-e2e-container}"
mkdir -p "${CACHE_ROOT}/node_modules" "${CACHE_ROOT}/vscode" "${CACHE_ROOT}/home"

# A TTY is right for an interactive developer run and fatal in CI, where there
# is none. Ask, rather than assume.
TTY_FLAGS=()
if [[ -t 0 && -t 1 ]]; then TTY_FLAGS=(-it); fi

# Expanded below as `${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"}` rather than the obvious
# `"${TTY_FLAGS[@]}"`. Under `set -u`, bash before 4.4 treats an EMPTY array's
# `[@]` expansion as an unset variable and aborts -- and the array is empty
# exactly when there is no TTY, which is the CI path this branch exists to
# serve. So the naive form works for every interactive developer run and dies
# only in CI, the one place nobody is watching a terminal. The `+` form
# expands to nothing when the array is unset or empty and is safe on every
# bash version. (macOS still ships bash 3.2 as /bin/bash.)

# Default command: the two things step 6 gates on.
DEFAULT_CMD='bun install --frozen-lockfile \
  && bun run build \
  && xvfb-run -a npx playwright test --config=playwright.e2e.config.ts tests/e2e/spike/launch.spec.ts --reporter=list \
  && xvfb-run -a bun scripts/capture-host-fixtures.ts'

CMD="${*:-${DEFAULT_CMD}}"

# --ipc=host: Chromium/Electron exhaust the default 64MB /dev/shm and crash in
# ways that look like flaky tests rather than an OOM.
# --init: reaps the zombie processes a killed Electron leaves behind.
#
# --user: the container writes into a bind-mounted host checkout, so it must
# write as the user that owns it. The image's own `pwuser` is uid 1000 and the
# invoking developer usually is not, which is what makes every write fail. This
# still runs unprivileged, so the Electron sandbox the Dockerfile is built
# around stays on -- the point is a non-root uid that matches the host, not root.
#
# HOME is redirected because the uid given above has no entry in the image's
# /etc/passwd, leaving HOME unset or pointing at pwuser's unwritable home; bun's
# install cache and Electron both need a writable one.
exec docker run --rm ${TTY_FLAGS[@]+"${TTY_FLAGS[@]}"} \
    --platform="${PLATFORM}" \
    --ipc=host \
    --init \
    --user "$(id -u):$(id -g)" \
    -e HOME=/cache/home \
    -e INTELLIGIT_VSCODE_CACHE=/cache/vscode \
    -v "${REPO_ROOT}:/work" \
    -v "${CACHE_ROOT}/node_modules:/work/node_modules" \
    -v "${CACHE_ROOT}/vscode:/cache/vscode" \
    -v "${CACHE_ROOT}/home:/cache/home" \
    -w /work \
    "${IMAGE_TAG}" \
    bash -lc "${CMD}"
