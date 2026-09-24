# Cartrends AutoFlow — sales bot
#
# Runs alongside ProcureHub and a dozen other containers on a box that is
# already memory- and CPU-constrained, so this image is deliberately small and
# the compose file caps what it can take. See docker-compose.yml.
#
# NOT installed on purpose:
#   * any character recogniser — photos go to vision (Gemini first, Claude
#     behind it), which costs a little money and no CPU. The local reader that
#     used to sit in front of it was Windows-only, never ran here, and has been
#     taken out of the code as well.
#   * puppeteer / chromium — only the old QR-linked-device transport needed
#     those, and the bot runs on the Cloud API now.
#
# INSTALLED, and worth the disk:
#   * python3 + pdfplumber / PyMuPDF — reading a PDF is parsing, not character
#     recognition. It costs milliseconds of CPU and is exact, where a picture
#     of the same page is a guess.
#   * faster-whisper — tried and removed, measured rather than assumed. On this
#     box the `small` model took 46 seconds on a 15-second clip and returned
#     Devanagari: too slow to answer with, and not a shape the part parser can
#     read. A voice note goes straight to a person, which is what they were
#     doing anyway. Finding that out cost 1.4 GB of image.
FROM node:22-slim

WORKDIR /app

# Python and the PDF libraries. Reading a PDF is parsing: milliseconds of CPU,
# and exact where a picture of the same page is a guess. --no-cache-dir
# and the purge keep pip's download cache out of the layer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages \
      pdfplumber==0.11.4 PyMuPDF==1.24.10 \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/* /root/.cache

# Dependencies first, so a code change does not re-download the world.
COPY package*.json ./
# PUPPETEER_SKIP_DOWNLOAD keeps whatsapp-web.js from pulling ~300MB of Chromium
# that this deployment never launches.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts
# The knowledge-base schema. Without it `npm run migrate` inside this image
# finds no migrations and reports "already up to date" on an empty database,
# which looks like success and is not.
COPY migrations ./migrations

# Orders, learned parts and the sale-loss log live here. Mounted as a volume by
# compose — without that, every rebuild would wipe what the bot has learned.
ENV DATA_DIR=/data
ENV TZ=Asia/Kolkata
ENV NODE_ENV=production

# No EXPOSE: this deployment polls the Render relay for incoming messages and
# opens no inbound port. Nothing on this host needs to reach it.
CMD ["node", "src/index.js"]
