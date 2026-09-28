# The Linux environment the runner needs: Wine, a fake display and a fake
# audio device, Node, and gamewatch.exe. The harness and the game repo are
# mounted in, not copied; see README.md, "Running on Linux".
#
#   docker build -t gg2-test linux

FROM ubuntu:24.04 AS gamewatch
RUN apt-get update && apt-get install -y --no-install-recommends gcc-mingw-w64-i686 \
    && rm -rf /var/lib/apt/lists/*
COPY gamewatch.c /src/
RUN i686-w64-mingw32-gcc -O2 -Wall -o /src/gamewatch.exe /src/gamewatch.c -luser32

FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
# GM8 is 32-bit, so it needs wine32 and 32-bit Mesa (llvmpipe) for Direct3D.
RUN dpkg --add-architecture i386 && apt-get update && apt-get install -y --no-install-recommends \
      wine wine32:i386 wine64 \
      libgl1:i386 libglx-mesa0:i386 libgl1-mesa-dri:i386 \
      xvfb x11-utils pulseaudio \
      nodejs git unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=gamewatch /src/gamewatch.exe /opt/gg2/gamewatch.exe
COPY headless.sh /usr/local/bin/headless
RUN chmod 755 /usr/local/bin/headless && mkdir /opt/gg2/wine && chown ubuntu /opt/gg2/wine

# ubuntu:24.04 already has uid 1000 ("ubuntu"), which owns the prefix. It is
# readable by all, because headless copies it for any other uid.
USER ubuntu
ENV HOME=/home/ubuntu WINEPREFIX=/opt/gg2/wine WINEDEBUG=-all DISPLAY=:99
# A Wine virtual desktop. With no window manager on Xvfb, every window the game
# hides otherwise costs a 2s wait_for_withdrawn_state timeout: 8s per start.
RUN wineboot -i \
    && wine reg add 'HKCU\Software\Wine\Explorer' /v Desktop /d Default /f \
    && wine reg add 'HKCU\Software\Wine\Explorer\Desktops' /v Default /d 1024x768 /f \
    && wineserver -w && chmod -R a+rX /opt/gg2/wine

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/headless"]
CMD ["bash"]
