#!/bin/bash
# Jia Raksa Sales Portal — start script
# ใช้โดย LaunchAgent (macOS auto-start)

export PATH="/Users/apple/.nvm/versions/node/v24.14.0/bin:$PATH"
cd "$(dirname "$0")"

exec node --experimental-sqlite \
  -e "require('dotenv').config(); require('./node_modules/ts-node').register(); require('./src/index.ts');"
