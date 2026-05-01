FROM python:3.11-slim

# Install build tools, Node.js, and cmake for dlib compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates build-essential cmake \
    libopenblas-dev liblapack-dev \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install face_recognition (dlib compiles from source — takes a few minutes)
RUN pip install --no-cache-dir face_recognition

WORKDIR /app

# Install Node deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source (exclude sample images and node_modules)
COPY server.js face_recognition_compare.py index.html app.js styles.css ./

EXPOSE 8080
ENV PORT=8080
ENV PYTHON=python

CMD ["node", "server.js"]
