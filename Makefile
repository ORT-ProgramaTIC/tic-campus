# tic-campus deploy, per ../DEPLOY-CONVENTIONS.md §3. Run as root from
# /opt/tic-campus (`sudo -i` first).

HOST ?= tic-campus.ort.edu.ar
SMOKE_BASE ?= http://localhost
SERVICES ?= api web

# tic-platform's database container. It is not in this compose project, so
# `docker compose exec` cannot see it: it is reached by name.
DB_CONTAINER ?= tic-db

# The secret compose MOUNTS into tic-campus-api. Checked before the roll:
# compose does check its `file:` sources, but only on `up` — by which point the
# old container is gone and the message is about a path rather than about the
# install step that was missed.
MOUNTED_SECRETS ?= secrets/db_svc_password

.PHONY: help deploy rollout config smoke doctor
help:  ## list targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | expand -t22

deploy:  ## pull, then roll with the freshly pulled Makefile
	git pull --ff-only
	$(MAKE) rollout

rollout:  ## the half of `deploy` after the pull — not called directly
	@docker network inspect tic-campus-edge >/dev/null 2>&1 || { \
	  echo "FAIL: the tic-campus-edge network does not exist — add [origins.tic-campus]"; \
	  echo "      to /var/lib/tic/config.toml and run \`tic apply-config\`."; exit 1; }
	@# The database, in both halves. The network, because compose refuses to start
	@# without it and its error names only the network; and the container's health,
	@# because the api comes up against it and would otherwise serve 503s from
	@# /api/readyz with nothing here saying why.
	@docker network inspect $(DB_CONTAINER) >/dev/null 2>&1 || { \
	  echo "FAIL: the $(DB_CONTAINER) network does not exist — run \`make -C /opt/tic-platform up\` first"; exit 1; }
	@test "$$(docker inspect -f '{{.State.Health.Status}}' $(DB_CONTAINER) 2>/dev/null)" = healthy || { \
	  echo "FAIL: $(DB_CONTAINER) is not healthy — run \`make -C /opt/tic-platform up\` first"; exit 1; }
	@test -r .env || { \
	  echo "FAIL: cannot read .env — compose reads it at parse time and every target needs it."; \
	  echo "      Copy .env.example to .env (root:root 0600) and fill it in."; exit 1; }
	@for f in $(MOUNTED_SECRETS); do \
	  test -r "$$f" || { \
	    echo "FAIL: cannot read $$f — tic-campus-api mounts it and refuses to boot without it."; \
	    echo "      Create it with \`install -m 0600 -o root -g root /dev/null $$f\` and paste campus_svc's password."; exit 1; }; \
	done
	docker compose build
	docker compose up -d
	@# A container about to crash is briefly `running`: three reads in a row.
	@for svc in $(SERVICES); do \
	  cid="$$(docker compose ps -q $$svc)"; ok=0; i=0; \
	  while [ $$i -lt 10 ] && [ $$ok -lt 3 ]; do \
	    [ "$$(docker inspect -f "{{.State.Status}}" $$cid)" = running ] && ok=$$((ok+1)) || ok=0; \
	    i=$$((i+1)); sleep 1; done; \
	  [ $$ok -ge 3 ] || { echo "FAIL: $$svc did not settle — docker compose logs $$svc"; exit 1; }; \
	  echo "ok: $$svc is running"; done
	$(MAKE) smoke

config:  ## validate docker-compose.yml
	docker compose config --quiet

smoke:  ## through tic-proxy with the real Host header, not around it
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/api/health | grep -q '"ok"' \
	  && echo "ok: /api/health through tic-proxy" \
	  || { echo "FAIL: /api/health did not answer through tic-proxy"; exit 1; }
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/ | grep -q 'TIC Campus' \
	  && echo "ok: / serves the frontend" \
	  || { echo "FAIL: / did not serve the frontend"; exit 1; }
	@# Liveness says the process answers; this says it reached the database as
	@# campus_svc and the directory grants are there. 503 carries the reason.
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/api/readyz | grep -q '"ok"' \
	  && echo "ok: /api/readyz — the api reaches tic-db as campus_svc" \
	  || { echo "FAIL: /api/readyz — see \`docker logs tic-campus-api\` and \`curl -H 'Host: $(HOST)' $(SMOKE_BASE)/api/readyz\`"; exit 1; }

# This stack's own diagnosis, in tic-host's contract (README, "Doctor"). Plain python3 on
# the host: the docker socket is what a process inside the containers cannot see.
# tic-platform's aggregator runs `bin/doctor.py --json` directly rather than through make,
# because make would print "Entering directory" onto a stream that promises one document.
doctor:  ## diagnóstico de este stack — [ok]/[warn]/[fail]/[skip], sale 1 si falla platform
	@python3 bin/doctor.py $(ARGS)
