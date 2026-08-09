# Deploying this project

Facts a deploy agent would otherwise have to derive from the source. They are
checked against the code, not aspirational — if one of them stops being true,
fix it here in the same change.

## Build

A `Dockerfile` sits at the context root, so `brainpod image build` uses it and
Railpack never runs. Nothing needs to be passed to the build: `RELEASE_ID` is a
build arg only so the local compose cluster can stamp an image, and the running
container reads it from the environment instead.

The compile stages are pinned to `$BUILDPLATFORM` because `next build` and `tsc`
emit platform-independent JavaScript. Only the runtime dependency install and
the final image target the cluster architecture. Do not pass `--platform` to
override this — the split is what keeps the build off the emulator on an ARM
host, and the CLI already resolves the target from the active clusters.

`.dockerignore` excludes `.brainpod`. The session console writes that directory
mid-deploy, so without the exclusion every deploy invalidates the `COPY . .`
layer and rebuilds the image from the dependency stage down.

## Runtime shape

- Listens on `PORT`, defaulting to 3000. The Dockerfile already sets it, so the
  Route rule can target 3000 without adding an env var.
- Runs as uid 1000 and writes nothing to disk. The app needs no `Disk` and no
  mounts; the databases need their own.
- Readiness is `GET /healthz`, which returns 200 and a JSON body naming the pod,
  release, region, leadership, connected client count and resident boards.
- WebSockets are served at `/ws`, with the board id in the `board` query
  parameter; absent means the default board. The Route has to pass upgrades
  through.
- `replicas` may be anything from 1 upward. Exactly one replica wins a Valkey
  lease and does the durable work — compacting the op log into Postgres, board
  snapshotting, stream trimming, presence pruning. Every replica, leader
  included, is an equal WebSocket gateway. Scaling either way is safe at any
  time, and drawing does not stop while the lease is vacant.

## Resources

`App` + `Route` + `Postgres` (version 16) + `Valkey` (version 9), and a `Disk`
for each of the two databases. The docs call the first one PostgresDB; the
resource kind the CLI validates against is `Postgres`. Kinds are PascalCase
inside a manifest and lowercase as a `resource get` argument, and cross-resource
URNs take the lowercase form: `urn:brain:disk:default:<name>`.

Instance size gates replica count, which the `App` schema does not say: `.5x`
rejects any `replicas` above 1 with `VALIDATION_ERROR` "Only 1 replica is
allowed for this instance". The App therefore needs at least `1x` for the
leader-and-gateways split to exist at all. `.5x` is fine for both databases.

The App itself takes no `Disk` and no mounts. That is a requirement rather than
an omission: an app with a disk mount is capped at a single instance, which
would take the multi-replica behaviour this project exists to show with it.

Schema migrations live in `migrations/` and are applied at boot under a Postgres
advisory lock, so every replica may start at once and no init step, job, or
`lifecycle.init` is needed.

## Environment

Required, both read at boot. Databases export their connection details as
variables an App's environment can reference, so use those rather than
assembling a URL by hand:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${<postgres-name>.uri}` |
| `REDIS_URL` | `${<valkey-name>.uri}` |

Postgres also exports `.host`, `.port`, `.user`, `.database`, and `.password`;
Valkey exports `.host`, `.port`, and `.password`. Both `uri` forms are TLS —
`postgres://...?sslmode=require` and `rediss://...`.

Neither client accepts those URLs as they come. `pg` reduces any `sslmode` to a
verifying `tls.connect`, which is stricter than libpq's `require` and cannot be
satisfied by a certificate issued for a pod-internal hostname, so `server/db.ts`
parses with `toClientConfig(parse(url, { useLibpqCompat: true }))` and passes the
config object rather than `connectionString`. `server/redis.ts` passes
`tls: { rejectUnauthorized: false }` for `rediss://`. Both failures land at boot,
after a green deploy — do not undo either.

The brainpod skill's `references/deploy.md` currently says the opposite: that the
resource API exposes no interpolation contract and that `${...}` must never
appear in `App.spec.env`. Trust this file instead, and do not spend a deploy
settling it. A provisioned database exposes only `healthy`, `status`, and `urn`,
and no CLI command anywhere prints credentials — so interpolation is the only
mechanism by which the App can reach one. `resource create --dry-run` cannot
adjudicate it either: it validates shape only, and accepts any non-empty string
as an env value.

Everything else has a working default and only needs setting to change it:
`REGION` (`eu-west-1`, shown in the corner badge), `RELEASE_ID`, `TRUST_PROXY`
(`1`; set `0` only with nothing trustworthy setting `X-Forwarded-For` in front),
`OPS_PER_SECOND` and `ERASES_PER_10S`. `POD_ID` defaults to the container
hostname, which is already unique per replica.

## Verifying a deploy

`/healthz` answering 200 means the process is up, not that the board works. The
whiteboard is live once one replica reports `"leader": true` and the root page
serves 200.

Nothing draws on its own, so a freshly deployed board is legitimately empty and
an empty board is not a broken database. What proves the stack from a terminal:
open a WebSocket to `/ws?board=lobby`, which confirms the Route passes upgrades, and
read the `welcome` message — it names the pod, the replica index and the release.
The first binary frame after it is the board snapshot, so a non-empty board
returns bytes there. Postgres is already proven by the process reaching ready at
all, since the boot migration throws on a failed connection.

To prove the multi-replica claim rather than assume it, open two sockets: the
Route round-robins them onto different pods, `welcome.replica` differs, and a
stroke drawn on one appears in the other's op frames within a fan-out interval.

## Local cluster

`docker compose --profile cluster up --build` runs Postgres, Valkey, two
replicas and Caddy on `localhost:3000`, which is the rig for rehearsing a
failover before a call. `docker compose stop app-a` mid-stroke is the drill —
the lease moves to `app-b` and the line being drawn continues.
