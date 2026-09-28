#!/bin/sh
# headless - start what GM8 needs before any game code runs, then run "$@".
#
# GM8 stops on a modal before its first line of GML without an audio device
# and a display. Both are fakes here: a PulseAudio null sink, and Xvfb with
# Mesa's software OpenGL under Wine's Direct3D.
#
# The Wine prefix in the image belongs to uid 1000, and Wine refuses a prefix
# someone else owns. Run as another user (docker run --user, as CI runners
# often need so that files written to a mounted checkout stay theirs) and this
# copies it to a home of that user's own first.
set -e

if [ "$(id -u)" != "$(stat -c %u "$WINEPREFIX")" ]; then
  export HOME="/tmp/home-$(id -u)"
  mkdir -p "$HOME"
  cp -r "$WINEPREFIX" "$HOME/.wine"
  export WINEPREFIX="$HOME/.wine"
fi

pulseaudio --daemonize=yes --exit-idle-time=-1 -n \
  --load="module-null-sink sink_name=null" --load="module-native-protocol-unix" >/dev/null 2>&1

Xvfb "$DISPLAY" -screen 0 1024x768x24 -nolisten tcp >/dev/null 2>&1 &
for i in $(seq 100); do
  xdpyinfo >/dev/null 2>&1 && break
  sleep 0.1
done

exec "$@"
