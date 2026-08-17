# BudgetKit Cloud Agent base image.
# BudgetKit requires Node 24+ because the DB layer uses the built-in `node:sqlite`
# module, which is only available on Node 24 and newer. The default Cloud Agent
# image ships Node 22, so we pin Node 24 here and pre-activate the repo's pinned
# pnpm version. Project dependencies are installed later by the `install` phase,
# after the repository revision is checked out.
FROM node:24-bookworm-slim

# git and curl are useful for source checkout and health checks in fully custom images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Activate the pnpm version pinned in the repo's package.json ("packageManager").
RUN corepack enable \
    && corepack prepare pnpm@10.28.0 --activate

USER node
