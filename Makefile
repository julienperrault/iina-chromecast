# ==============================================================================
# IINA Chromecast Plugin (io.iina.chromecast) — Makefile
# ==============================================================================

NODE        ?= node
NPM         ?= npm
DAEMON_PORT := 45890
PLUGIN_DIR  := $(HOME)/Library/Application Support/com.colliderli.iina/plugins/io.iina.chromecast.iinaplugin-dev
PACKAGE_ZIP := iina-chromecast.iinaplugin.zip

.PHONY: help all build lint deadcode check link package daemon-start daemon-stop daemon-restart daemon-status clean

all: check

help:
	@echo "IINA Chromecast Plugin — Available Make Targets:"
	@echo ""
	@echo "  make build           Bundle and minify dist/daemon.js and dist/index.js"
	@echo "  make lint            Run static analysis, thread-safety & i18n checks (en/fr/es)"
	@echo "  make deadcode        Audit codebase for unused translation keys & dead code"
	@echo "  make check           Run linter + build + daemon restart"
	@echo "  make link            Symlink plugin into IINA's plugins folder (dev mode)"
	@echo "  make package         Build and create distributable $(PACKAGE_ZIP)"
	@echo "  make daemon-start    Start the detached Chromecast background daemon"
	@echo "  make daemon-stop     Stop the running Chromecast background daemon"
	@echo "  make daemon-restart  Rebuild and restart the Chromecast background daemon"
	@echo "  make daemon-status   Query the running daemon state on 127.0.0.1:$(DAEMON_PORT)"
	@echo "  make clean           Remove dist/ bundles and packaged .zip archive"

lint:
	$(NODE) lint.js

deadcode:
	$(NODE) lint.js --deadcode-only

build:
	$(NODE) build.js

check: lint build daemon-restart

link:
	ln -sfn "$(CURDIR)" "$(PLUGIN_DIR)"
	@echo "Linked -> $(PLUGIN_DIR)"

daemon-stop:
	@pkill -f "daemon.js --run-server" 2>/dev/null || true
	@echo "Chromecast daemon stopped."

daemon-start: build
	@$(NODE) dist/daemon.js --spawn-daemon
	@sleep 0.5
	@echo "Chromecast daemon started on http://127.0.0.1:$(DAEMON_PORT)"

daemon-restart: daemon-stop daemon-start

daemon-status:
	@curl -s http://127.0.0.1:$(DAEMON_PORT)/state || echo '{"ok":false,"error":"Daemon not running"}'
	@echo ""

package: lint build
	rm -f $(PACKAGE_ZIP)
	zip -r $(PACKAGE_ZIP) Info.json dist ui i18n README.md docs LICENSE
	@echo "Created $(PACKAGE_ZIP)"

clean:
	rm -rf dist $(PACKAGE_ZIP)
	@echo "Cleaned build artifacts."
