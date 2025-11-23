FROM --platform=linux/arm64 docker.io/cloudflare/sandbox:0.5.1

WORKDIR /workspace

RUN bun install -g opencode-ai

ENV PATH="/root/.bun/bin:${PATH}"

EXPOSE 8080
