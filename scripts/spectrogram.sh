#!/usr/bin/env bash
# Make sox spectrogram
source /etc/birdnet/birdnet.conf

# Read the logging level from the configuration option
LOGGING_LEVEL="${LogLevel_SpectrogramViewerService}"
# If empty for some reason default to log level of error
[ -z $LOGGING_LEVEL ] && LOGGING_LEVEL='error'
# Additionally if we're at debug or info level then allow printing of script commands and variables
if [ "$LOGGING_LEVEL" == "info" ] || [ "$LOGGING_LEVEL" == "debug" ];then
  # Enable printing of commands/variables etc to terminal for debugging
  set -x
fi

next=0
looptime=$(( RECORDING_LENGTH * 2 / 3 ))

touch "$HOME/BirdSongs/StreamData/analyzing_now.txt"
# Continuously loop generating a spectrogram
inotifywait -m -e close_write "$HOME/BirdSongs/StreamData/analyzing_now.txt" |
while read; do
  now=$(date +%s)
  if (( now > next )); then
    analyzing_now="$(<$HOME/BirdSongs/StreamData/analyzing_now.txt)"

    if [ -n "${analyzing_now}" ] && [ -f "${analyzing_now}" ]; then
      spectrogram_png=${EXTRACTED}/spectrogram.png
        # `-t "" -c ""` matches how THIS fork renders every other spectrogram —
        # scripts/utils/reporting.py:52 passes empty title and comment to sox and
        # then draws the species name on with PIL. Upstream instead passed the
        # wav's PATH as the comment, so the live spectrogram carried a strip of
        # "BirdSongs/StreamData/2026-07-30-birdnet-16:46:27.wav" baked into the
        # image plus sox's default title — which is why it read as a debug plot
        # next to the clean ones under every recording. There is no species to
        # title here (nothing has been identified yet), so the live frame stays
        # untitled rather than gaining a caption it cannot honestly fill.
        if [ "$RAW_SPECTROGRAM" == "1" ]; then
          # If it is, add "-r" as an argument to the SOX command
          sox -V1 "${analyzing_now}" -n remix 1 rate 24k spectrogram -t "" -c "" -o "${spectrogram_png}" -r
        else
          sox -V1 "${analyzing_now}" -n remix 1 rate 24k spectrogram -t "" -c "" -o "${spectrogram_png}"
        fi
    fi
    next=$(( now + looptime ))
  fi
done
