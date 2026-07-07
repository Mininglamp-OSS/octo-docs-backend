FROM node:22-alpine
WORKDIR /app

# Chromium + CJK/emoji fonts for server-side PDF export (Puppeteer).
#
# We depend on the full `puppeteer` package (bundled Chromium works for local
# dev), but Alpine is musl and puppeteer's downloaded Chromium is glibc-only, so
# in the image we install the system chromium and drive THAT: PUPPETEER_SKIP_
# DOWNLOAD=true (below, set before `npm ci`) skips the useless download and
# PUPPETEER_EXECUTABLE_PATH points the same puppeteer import at the apk binary.
#
# font-noto-cjk gives real CJK glyphs and font-noto-emoji real emoji in the PDF.
#
# Memory note: a headless Chromium adds ~300MB RSS under load. PDF render
# concurrency is capped in pdfService.ts (env PDF_EXPORT_MAX_CONCURRENT, default
# 2) and the browser is recycled every PDF_EXPORT_RECYCLE_AFTER_PAGES pages.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
      font-noto \
      font-noto-cjk \
      font-noto-emoji

# Tell puppeteer where the system chromium lives, and skip its own download.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000 1234

CMD ["node", "dist/index.js"]
