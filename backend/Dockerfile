FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py ./
COPY seed.py ./
COPY acceptance.py ./
COPY fhapi/ ./fhapi/
COPY tests/ ./tests/

ENV FILEHUB_RUNTIME_DIR=/app/runtime
ENV PORT=8787
EXPOSE 8787
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8787"]
