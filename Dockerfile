FROM node:22-alpine
WORKDIR /app

# CJK + emoji fonts for server-side PDF export (Typst).
#
# The PDF export renders the document to Typst source and compiles it with the
# standalone `typst` binary (see below). Typst resolves fonts from the system
# font book, so the image must carry real CJK and emoji faces:
#   - font-noto-cjk  → Chinese/Japanese/Korean glyphs
#   - font-noto-emoji → colour emoji (matches what the editor shows)
RUN apk add --no-cache \
      font-noto \
      font-noto-cjk \
      font-noto-emoji

# Typst binary for server-side PDF export (renderTypst.ts / typstService.ts).
#
# Typst is a single static Rust binary (~30MB) with no browser or LaTeX
# dependency and no resident process — each export spawns a short-lived,
# network-less, sandboxed child. We fetch the musl static release and drop it on
# PATH. The version is pinned for reproducible builds; bump deliberately.
# Compile concurrency is capped in typstService.ts (TYPST_EXPORT_MAX_CONCURRENT,
# default 2).
ARG TYPST_VERSION=v0.13.1
RUN apk add --no-cache --virtual .typst-fetch curl tar xz \
    && ARCH="$(uname -m)" \
    && case "$ARCH" in \
         x86_64) TARGET=x86_64-unknown-linux-musl ;; \
         aarch64) TARGET=aarch64-unknown-linux-musl ;; \
         *) echo "unsupported arch $ARCH" && exit 1 ;; \
       esac \
    && curl -fsSL "https://github.com/typst/typst/releases/download/${TYPST_VERSION}/typst-${TARGET}.tar.xz" -o /tmp/typst.tar.xz \
    && tar -xJf /tmp/typst.tar.xz -C /tmp \
    && install -m 0755 "/tmp/typst-${TARGET}/typst" /usr/local/bin/typst \
    && rm -rf /tmp/typst.tar.xz "/tmp/typst-${TARGET}" \
    && apk del .typst-fetch \
    && typst --version

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000 1234

CMD ["node", "dist/index.js"]
