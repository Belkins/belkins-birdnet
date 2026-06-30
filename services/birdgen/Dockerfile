FROM python:3.12-slim

WORKDIR /app

# System deps for Pillow wheels are bundled in manylinux; nothing extra needed
# for runtime. Keep the image slim.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# The generation pipeline + bundled prompt/notes/manifest are all copied above.
# PNGs + SQLite lease live on the Railway volume mounted at /data/assets.
ENV ASSETS_DIR=/data/assets

EXPOSE 8000

# Railway injects $PORT; default to 8000 for local runs.
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
