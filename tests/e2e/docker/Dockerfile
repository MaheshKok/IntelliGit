# The pinned Linux container for Phase 0's gate (PLAN.md step 6) and, later,
# the only place Layer 1 pixel baselines may be generated (PLAN.md step 20).
#
# The base image is passed in as a DIGEST by `run.sh`, read from the checked-in
# `base-image.txt`, rather than written here as a tag. A tag like
# `v1.62.1-noble` is mutable: the same Dockerfile would silently produce a
# different filesystem — and therefore different font rendering and different
# pixels — after an upstream rebuild, turning every committed baseline stale
# with no diff to show for it. A digest cannot move.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

# Re-declared after FROM so it is readable in the build below (ARGs before the
# first FROM are outside the build stage's scope) — recorded into the image so a
# running container can report the exact base it was built from.
ARG BASE_IMAGE
ENV INTELLIGIT_BASE_IMAGE=${BASE_IMAGE}

# The Playwright base already carries the shared libraries Chromium needs, which
# covers the Electron that VS Code ships. Only the pieces this repo's own
# toolchain needs are added here.
#
# `git` is not a convenience: the fixture repository IS git state, so the git
# build in this image is part of the test contract. Pin nothing else silently —
# if a future step needs a specific git version, pin it here with a reason.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun runs this repo's build and capture scripts (`bun run build`,
# `bun scripts/capture-host-fixtures.ts`). Installed to a shared location so the
# unprivileged user below can run it.
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
RUN curl -fsSL https://bun.sh/install | bash \
    && chmod -R a+rx ${BUN_INSTALL}

# Run unprivileged, NOT root. Electron refuses to start its sandbox as root, and
# the usual workaround (`--no-sandbox`) would make the container diverge from how
# VS Code actually runs — a difference that lands in the very pixels this
# container exists to produce. Dropping privileges keeps the sandbox on and needs
# no launch-flag divergence at all.
#
# `run.sh` overrides this with `--user <host uid>:<host gid>`, because the
# container writes into a bind-mounted host checkout and must own what it writes.
# That is still unprivileged, so the sandbox reasoning above holds either way.
# This line is the safe default for anyone running the image without run.sh.
USER pwuser

# The VS Code download cache must live outside the repo: an in-repo build under
# `--extensionDevelopmentPath` makes VS Code treat its own bundled themes as the
# development extension's and overrides `workbench.colorTheme` entirely. See
# `tests/e2e/hostFixtures/resolveVSCodeExecutable.ts`, which asserts this.
#
# `run.sh` overrides this too, pointing it at a host-owned bind mount — a path
# under /home/pwuser is not writable by the uid it runs as.
ENV INTELLIGIT_VSCODE_CACHE=/home/pwuser/.cache/intelligit-vscode-test

WORKDIR /work
