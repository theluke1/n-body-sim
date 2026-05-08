#!/bin/bash
# Start the N-Body Sim v3 dev server and open the browser
cd "$(dirname "$0")"

# Install dependencies if node_modules doesn't exist yet
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install
fi

echo "Starting N-Body Sim v3..."
sleep 2 && open http://localhost:5173 &
npm run dev
