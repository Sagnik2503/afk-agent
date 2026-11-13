FROM node:22
RUN apt-get update && \
    apt-get install -y git && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@1.19.5

WORKDIR /workspace

RUN chown node:node /workspace

USER node