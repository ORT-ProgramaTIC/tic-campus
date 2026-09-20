# tic-campus deploy, per ../DEPLOY-CONVENTIONS.md §3. Run as root from
# /opt/tic-campus (`sudo -i` first).

HOST ?= tic-campus.ort.edu.ar
SMOKE_BASE ?= http://localhost
SERVICES ?= api web

# tic-platform's database container. It is not in this compose project, so
# `docker compose exec` cannot see it: it is reached by name.
DB_CONTAINER ?= tic-db

# The bytes of every upload (F9). Created by hand, once per box, and declared
# `external` in compose for the same reason tic-platform declares tic-db-data
# that way: this is the only copy outside the nightly backup.
UPLOADS_VOLUME ?= tic-campus-uploads

# The secret compose MOUNTS into tic-campus-api. Checked before the roll:
# compose does check its `file:` sources, but only on `up` — by which point the
# old container is gone and the message is about a path rather than about the
# install step that was missed.
MOUNTED_SECRETS ?= secrets/db_svc_password secrets/tic_auth_client_secret

# Migrations run as the schema OWNER, never as the runtime role. campus_svc is a
# member of campus_app, which holds DML on `campus` and deliberately no CREATE —
# the asymmetry that makes tic-auth's grant matrix real rather than decorative
# (tic-auth/docs/CONSISTENCY.md). So this password is NOT in MOUNTED_SECRETS: it
# is read here on the host and never enters a container.
#
# It is not in the URL either. It goes through PGPASSWORD, which libpq and
# node-postgres both read, because a password with the wrong byte in it breaks
# URL parsing before the database is ever reached. Measured in MEV against
# pg-connection-string@2.x: a '/', '?' or '#' throws `Invalid URL`, and a '%XX'
# sequence is silently percent-DECODED into a different byte. `openssl rand
# -hex 32`, as .env.example says, sidesteps all of it.
DB_OWNER_PASSWORD_FILE ?= secrets/db_owner_password
MIGRATION_DB_URL ?= postgresql://campus_owner@tic-db:5432/tic_auth

# `make test-db`'s throwaway Postgres. It is a DEVELOPMENT target and is not
# part of `deploy`: it pulls an image and needs a Docker daemon, neither of
# which belongs in a production roll.
TEST_DB_CONTAINER ?= tic-campus-test-db
TEST_DB_IMAGE ?= postgres:17
TEST_DB_PORT ?= 55433

.PHONY: help deploy rollout config migrate test-db smoke doctor
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
	@# The uploads volume (F9). `external: true`, so compose refuses to start
	@# without it — but its message names a volume, not the install step that
	@# was missed, and creating one by hand at that point is the difference
	@# between an empty stack and a stack whose files are somewhere else.
	@docker volume inspect $(UPLOADS_VOLUME) >/dev/null 2>&1 || { \
	  echo "FAIL: the $(UPLOADS_VOLUME) volume does not exist — \`docker volume create $(UPLOADS_VOLUME)\`."; \
	  echo "      It holds every file teachers upload (F9) and is deliberately NOT created by"; \
	  echo "      compose, so that \`docker compose down -v\` cannot take them with it."; exit 1; }
	@test -r .env || { \
	  echo "FAIL: cannot read .env — compose reads it at parse time and every target needs it."; \
	  echo "      Copy .env.example to .env (root:root 0600) and fill it in."; exit 1; }
	@# `-s` and not `-r`: the install step creates these EMPTY (`install /dev/null`)
	@# and then fills them, and a command whose output was redirected here can
	@# leave one empty too — `issue-secret` run in the wrong directory writes
	@# nothing to stdout while its error goes to /dev/null. An empty file passes
	@# `-r`, so the api boots, refuses its own config and crash-loops, and the
	@# only thing that says why is the container's log.
	@for f in $(MOUNTED_SECRETS); do \
	  test -s "$$f" || { \
	    echo "FAIL: $$f no existe o está vacío — tic-campus-api lo monta y no arranca sin él."; \
	    echo "      Crealo con \`install -m 0600 -o root -g root /dev/null $$f\` y pegá la credencial:"; \
	    echo "      la contraseña de campus_svc, o el secreto de cliente de tic-auth — README, 'El login'."; exit 1; }; \
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
	$(MAKE) migrate
	$(MAKE) smoke

config:  ## validate docker-compose.yml
	docker compose config --quiet

migrate:  ## aplicar las migraciones como campus_owner — `deploy` ya lo hace
	@test -r $(DB_OWNER_PASSWORD_FILE) || { \
	  echo "FAIL: cannot read $(DB_OWNER_PASSWORD_FILE) — migrations run as the schema owner"; \
	  echo "      and need its password."; \
	  echo "      Create it with \`install -m 0600 -o root -g root /dev/null $(DB_OWNER_PASSWORD_FILE)\`"; \
	  echo "      and paste campus_owner's password. See README, 'The database'."; exit 1; }
	@# THE migration path, and the only one. Boot does not migrate and cannot:
	@# the container connects as campus_svc, which holds no CREATE anywhere. So
	@# the one command allowed to restructure anything is the only one holding
	@# CREATE, and a container serving against a schema this has not been run on
	@# reports it at /api/readyz rather than 500ing on whichever route notices.
	@#
	@# `exec` into the api container rather than a container of its own: the
	@# migrator is `dist/db/migrate.js` in that same image, and tic-db is
	@# `internal: true` — the api is already on that network.
	docker compose exec -T \
	  -e DATABASE_URL="$(MIGRATION_DB_URL)" \
	  -e PGPASSWORD="$$(cat $(DB_OWNER_PASSWORD_FILE))" \
	  api node dist/db/migrate.js

test-db:  ## las pruebas que necesitan un Postgres de verdad — en una base descartable
	@# A container of its own, removed either way, because the assertions are
	@# about GRANTS: they create four roles and a schema, and a database that
	@# survived one run would fail the next on `role "campus" already exists`.
	@#
	@# The test suite reads `api/test/support/directory/standins.generated.sql`,
	@# the committed slice of tic-auth's schema — so this needs neither Python
	@# nor a tic-auth checkout. `pnpm --filter tic-campus-api db:stubs:check` is
	@# what proves that file still matches upstream, and it needs both.
	@docker rm -f $(TEST_DB_CONTAINER) >/dev/null 2>&1 || true
	@docker run -d --rm --name $(TEST_DB_CONTAINER) \
	  -e POSTGRES_PASSWORD=harness-only-not-a-secret \
	  -e POSTGRES_DB=tic_auth \
	  -p 127.0.0.1:$(TEST_DB_PORT):5432 $(TEST_DB_IMAGE) >/dev/null
	@trap 'docker rm -f $(TEST_DB_CONTAINER) >/dev/null 2>&1 || true' EXIT; \
	  for i in $$(seq 30); do \
	    docker exec $(TEST_DB_CONTAINER) pg_isready -q -U postgres && break; sleep 1; \
	  done; \
	  TEST_DATABASE_URL="postgresql://postgres:harness-only-not-a-secret@127.0.0.1:$(TEST_DB_PORT)/tic_auth" \
	    pnpm --filter tic-campus-api test

smoke:  ## through tic-proxy with the real Host header, not around it
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/api/health | grep -q '"ok"' \
	  && echo "ok: /api/health through tic-proxy" \
	  || { echo "FAIL: /api/health did not answer through tic-proxy"; exit 1; }
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/ | grep -q 'TIC Campus' \
	  && echo "ok: / serves the frontend" \
	  || { echo "FAIL: / did not serve the frontend"; exit 1; }
	@# Liveness says the process answers; this says it reached the database as
	@# campus_svc, that the directory grants are there, and that the schema is
	@# the one this build was written against. 503 carries which of the three.
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/api/readyz | grep -q '"status":"ok"' \
	  && echo "ok: /api/readyz — tic-db as campus_svc, migraciones al día" \
	  || { echo "FAIL: /api/readyz — see \`docker logs tic-campus-api\` and \`curl -H 'Host: $(HOST)' $(SMOKE_BASE)/api/readyz\`"; exit 1; }
	@# The unauthenticated half of the login, which is still proof the route is
	@# mounted: 401 means the session middleware answered, 404 means the four
	@# routes are not there at all — which is what an unconfigured client secret
	@# looks like, deliberately (CLIENTS.md §8).
	@test "$$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: $(HOST)' $(SMOKE_BASE)/api/me)" = 401 \
	  && echo "ok: /api/me contesta 401 sin sesión" \
	  || { echo "FAIL: /api/me no contestó 401 — si contesta 404 falta secrets/tic_auth_client_secret"; exit 1; }
	@# The first check that campus can READ the directory through a route rather
	@# than through /api/readyz's own query: this one goes through the ORM, the
	@# joins and `campus_app`'s SELECT on four views at once. An empty array is a
	@# pass — a stack with nothing activated yet (F34) is a working stack.
	@curl -fsS -H 'Host: $(HOST)' $(SMOKE_BASE)/api/offerings | grep -q '^\[' \
	  && echo "ok: /api/offerings lee el directorio como campus_svc" \
	  || { echo "FAIL: /api/offerings no devolvió una lista — \`docker logs tic-campus-api\`"; exit 1; }
	@# **A `kid`, never a 200.** The JWKS goes through tic-proxy with a Host
	@# header, and that header fails soft: omit it and nginx's default server
	@# answers 200 with a body that is not a key set. Asked with the api's own
	@# probe, so this and the application cannot disagree about "reachable".
	@docker compose exec -T api node dist/scripts/check-jwks.js >/dev/null \
	  && echo "ok: tic-campus-api lee el JWKS de tic-auth por tic-proxy" \
	  || { echo "FAIL: no se pudo leer el JWKS — \`docker compose exec api node dist/scripts/check-jwks.js\`"; exit 1; }

# This stack's own diagnosis, in tic-host's contract (README, "Doctor"). Plain python3 on
# the host: the docker socket is what a process inside the containers cannot see.
# tic-platform's aggregator runs `bin/doctor.py --json` directly rather than through make,
# because make would print "Entering directory" onto a stream that promises one document.
doctor:  ## diagnóstico de este stack — [ok]/[warn]/[fail]/[skip], sale 1 si falla platform
	@python3 bin/doctor.py $(ARGS)
