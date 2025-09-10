#!/bin/bash

# Check if pio is available
if ! command -v pio &> /dev/null
then
    echo "PlatformIO (pio) could not be found, please install it to proceed."
    exit 1
fi

# First, read in the platformio config via pio
PLATFORMIO_CONFIG=$(pio project config)
if [ $? -ne 0 ]; then
    echo "Failed to read PlatformIO configuration."
    exit 1
fi

# CONFIGS is every line that starts with "env:". then only ones that start with tallylight
CONFIGS=$(echo "$PLATFORMIO_CONFIG" | grep -oP '(?<=^env:).+' | grep '^tallylight')

if [ -z "$CONFIGS" ]; then
    echo "No configurations found."
    exit 1
fi

FAILED_CONFIGS=()

# Loop through each config and run pio run -e <config> -t upload
for CONFIG in $CONFIGS; do
    echo "Updating configuration: $CONFIG"
    pio run -e "$CONFIG" -t upload
    if [ $? -ne 0 ]; then
        echo "Failed to update configuration: $CONFIG"
        FAILED_CONFIGS+=("$CONFIG")
        continue
    fi
    echo "Successfully updated configuration: $CONFIG"

    # wait a bit before next upload
    sleep 2
done

# print summary
if [ ${#FAILED_CONFIGS[@]} -ne 0 ]; then
    echo "The following configurations failed to update:"
    for FAILED_CONFIG in "${FAILED_CONFIGS[@]}"; do
        echo "- $FAILED_CONFIG"
    done
    exit 1
else
    echo "All configurations updated successfully."
    exit 0
fi