#!/bin/sh
# Tor jako zapasowa droga do SAOS (wspoldzielone IP CGNAT bywa blokowane): pierwsze zapytanie idzie wprost,
# ponowienia przez SOCKS z losowymi danymi = nowy obwod. SAOS_TOR=0 wylacza.
if [ "${SAOS_TOR:-1}" = "1" ]; then
  mkdir -p /tmp/tor-data
  if tor --SocksPort 9050 --DataDirectory /tmp/tor-data --Log "notice file /tmp/tor.log" --RunAsDaemon 1 >/dev/null 2>&1; then
    export SAOS_TOR_PROXY=socks5h://127.0.0.1:9050
  fi
fi
exec node dist/index.js
