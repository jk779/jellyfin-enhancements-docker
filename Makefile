# Makefile for Jellyfin Caddy Proxy
# Usage:
#   make caddy-reload   -> reloads the Caddy config inside the container
#   make caddy-logs     -> tails the Caddy logs
#   make caddy-shell    -> opens a shell in the Caddy container

CADDY_CONTAINER = jellyfin-caddy
CADDY_CONFIG    = /etc/caddy/Caddyfile

.PHONY: caddy-reload caddy-logs caddy-shell

caddy-reload:
	@echo "🔁 Reloading Caddy configuration in $(CADDY_CONTAINER)..."
	@docker exec $(CADDY_CONTAINER) caddy reload --config $(CADDY_CONFIG)
	@echo "✅ Reload complete."

caddy-logs:
	@docker logs -f $(CADDY_CONTAINER)

caddy-shell:
	@docker exec -it $(CADDY_CONTAINER) /bin/sh

# Auto-completion helper: list all available targets
.PHONY: help
help:
	@awk -F':| ' '/^[a-zA-Z0-9\-_]+:/ {print $$1}' $(MAKEFILE_LIST) | sort | uniq