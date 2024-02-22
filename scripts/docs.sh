#!/bin/bash

# Step 1: Clone the aframe repository
git clone https://github.com/aframevr/aframe --depth 1

# Step 2: Delete the scripts/docs directory if it exists
rm -rf scripts/docs

# Step 3: Copy the aframe/docs directory to scripts/docs
cp -r aframe/docs scripts/docs

# Step 4: Run the processDocs.mjs script on scripts/docs/
node scripts/processDocs.js scripts/docs/

# Step 5: Delete the cloned aframe directory
rm -rf aframe

# Step 6: Delete the scripts/docs directory
rm -rf scripts/docs

echo "Process completed."
