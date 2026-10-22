FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY ms-mcp/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY ms-mcp/server.py ms-mcp/ms_cache.py /app/
COPY ms-mcp/vendor /app/vendor
RUN python -m py_compile server.py vendor/orzeczenia_ms.py
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import socket; s=socket.create_connection(('127.0.0.1', 8000), 4); s.close()"
CMD ["python", "server.py"]
