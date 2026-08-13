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
#
# These versions are deliberately NOT pinned, and that is a different decision
# from the Bun install below rather than an inconsistency. apt verifies every
# package against the distribution's signed release index before unpacking it,
# so an unpinned `apt-get install` is authenticated even though it is not
# reproducible; a piped installer script is neither. What version drift here
# could still cost is pixel reproducibility — and none of these three packages
# rasterizes anything, so they cannot move a baseline. Pinning exact versions
# would instead break the build outright every time Ubuntu supersedes one of
# them in the archive. If a future step needs true version reproducibility, the
# lever is a snapshot.ubuntu.com mirror, not a version literal that expires.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

# Bun runs this repo's build and capture scripts (`bun run build`,
# `bun scripts/capture-host-fixtures.ts`). Installed to a shared location so the
# unprivileged user below can run it.
ENV BUN_INSTALL=/usr/local/bun
ENV PATH=${BUN_INSTALL}/bin:${PATH}
#
# Fetched as a checksummed release artifact rather than through
# `curl https://bun.sh/install | bash`. The digest reasoning at the top of this
# file applies here too, and more sharply: piping an installer into a shell runs
# whatever that host serves at build time, un-versioned and un-verified, as root
# in the image that produces this repo's test evidence — and `run.sh` then hands
# that toolchain a read-write bind mount of the checkout and the caches. Passing
# a version to that installer pins what an honest installer does; it does not
# pin the installer. A checksum does, and a substituted archive cannot satisfy
# one.
#
# `linux-x64` is not a new assumption — run.sh builds with `--platform=linux/amd64`.
# Bumping BUN_VERSION without bumping BUN_SHA256 moves the URL to an archive the
# old checksum rejects, so the two cannot drift apart; the final `bun --version`
# comparison then proves the extracted bytes really are that release.
ARG BUN_VERSION=1.3.5
ARG BUN_SHA256=7051d86a924aefea3e0b96213b5fd8f79c0793f9cae6534233e627e5c3db4669
RUN mkdir -p ${BUN_INSTALL}/bin \
    && curl -fsSL -o /tmp/bun.zip \
        "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -j /tmp/bun.zip 'bun-linux-x64/bun' -d ${BUN_INSTALL}/bin \
    && rm /tmp/bun.zip \
    && chmod -R a+rx ${BUN_INSTALL} \
    && [ "$(bun --version)" = "${BUN_VERSION}" ]

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
