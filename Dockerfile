FROM denoland/deno:latest

WORKDIR /app

COPY . .

# Download every dependency at BUILD time; otherwise each cold start (e.g. a
# Render free-tier spin-up) re-downloads them before serving the first request.
RUN deno cache main.ts

EXPOSE 8000

CMD ["deno", "task", "start"]
