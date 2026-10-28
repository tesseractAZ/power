## 12. Configuration, Deployment, Security & Operations

This is the operations reference for the **ecoflow-panel** Home Assistant add-on (add-on
name/`panel_title`: **"Power"**, slug: `ecoflow_panel`). It documents every configuration
option and the env var it maps to, the options→env bridge, the security posture (AppArmor,
write-auth, CORS, the write-debug lockdown), the CI + release pipeline, the ingress/port map,
and the operational runbook.

Sources of truth cited throughout:
- `ecoflow_panel/config.yaml` — add-on manifest + options + schema (`version:` is bumped every release; the file is authoritative)
- `server/src/config.ts` — the option table (`OPTIONS`): every option, every environment knob and the deployment constants, each with its export form and the parse rule its reader applies
- `ecoflow_panel/translations/en.yaml` — per-field labels/help on the HA Configuration page
- `rootfs/etc/services.d/ecoflow-panel/run` — the s6 service runner (options→env bridge); `rootfs/usr/bin/ecoflow-panel-backup-hook` — the backup hook
- `server/src/auth.ts` — write-auth gate, CORS allow-list, token bootstrap
- `server/src/ecoflow/commands.ts`, `server/src/writeLog.ts` — write-debug lockdown + audit log
- `ecoflow_panel/apparmor.txt` — the LSM confinement profile
- `.github/workflows/{ci,codeql,release-pr,release,tag-release,images}.yml` — CI, the CodeQL gate, the release-PR check and the release/publish pipeline
- `Dockerfile`, `build.yaml`, `repository.yaml` — image build + add-on repository manifest

---

### Add-on manifest (config.yaml top-level)

These are the non-option keys of `ecoflow_panel/config.yaml` — they define how HA Supervisor
runs the container.

| Key | Value | Meaning |
|-----|-------|---------|
| `name` | `Power` | Store display name |
| `version` | *(current release)* | Add-on version; the **release trigger** (see Release Pipeline). HA compares this to installed to surface the Update button. |
| `slug` | `ecoflow_panel` | Stable identifier — used in the HA add-on API path (`.../addons/local_ecoflow_panel/...` for a local install, or the store slug). Never change it. |
| `arch` | `aarch64`, `amd64` | Supported CPU arches (a Raspberry Pi is aarch64) |
| `image` | `ghcr.io/tesseractaz/{arch}-ecoflow-panel` | **Pre-built GHCR image**; `{arch}` substituted by Supervisor. Presence of this key means Supervisor *pulls* the image rather than building on the host. |
| `startup` | `services` | Start in the "services" phase of HA boot |
| `boot` | `auto` | Auto-start on HA boot |
| `stage` | `experimental` | Add-on maturity stage |
| `init` | `false` | **Critical.** Disables Docker's tini so the HA base image's own s6-overlay `/init` runs as PID 1. With tini in front, `s6-overlay-suexec` refuses to start (`fatal: can only run as pid 1`) → crash loop. Do not flip to true. |
| `ports` | `8787/tcp`, `2323/tcp` | Directly-published host ports (see Port Map) |
| `ingress` | `true` | Panel appears as an HA sidebar item, authenticated through HA's session |
| `ingress_port` | `8787` | Same server/port the Supervisor reverse-proxies into |
| `panel_icon` | `mdi:home-battery` | Sidebar icon |
| `panel_title` | `Power` | Sidebar label |
| `panel_admin` | `false` | Non-admin HA users may see the sidebar panel |
| `map` | `data:rw`, `share:rw` | `/data` read-write (persistence). `/share` read-write (v1.107.0) so the SQLite snapshot (`POST /api/db-export`, §12g) is published where other add-ons can read it; the add-on writes only that snapshot and the backup hook's journal (`ecoflow-panel/backup-window.jsonl`) there. |
| `backup` | `hot` | Home Assistant backs the add-on up while it runs (v1.187.20): a cold backup would stop the alarm engine for the whole copy. |
| `backup_pre` / `backup_post` | `/usr/bin/ecoflow-panel-backup-hook pre` / `post` | Run by the Supervisor inside the container around the copy of `/data`: `pre` empties the SQLite WAL and holds checkpoints still, `post` restores them (`backupWindow.ts`, over the loopback-only routes below; a 10-minute dead-man restores them if `post` never comes). The hook always exits 0, since a non-zero exit drops the add-on from the backup. |
| `homeassistant_api` | `true` | Grants `SUPERVISOR_TOKEN` access to Core `/core/api/*` — needed for `media_player.play_media` broadcasts and entity-state reads. Without it, broadcasts fail with "SUPERVISOR_TOKEN missing or HA unreachable". |
| `hassio_api` | `true` | Grants Supervisor API access (read-only survey of installed add-ons for Piper/speaker visibility). |
| `hassio_role` | `homeassistant` | **Least-privilege (v1.7.0, CWE-250).** Downgraded from `manager`. `homeassistant` keeps Core API + the read it needs but drops add-on start/stop/reconfigure that `manager` would grant a compromised process. Bump back to `manager` only if a feature needs true add-on management. |

`repository.yaml` makes the repo installable as an HA add-on repository (name `Power`,
maintainer `tesseractAZ`). Once added under **Settings → Add-ons → Add-on Store → ⋮ →
Repositories**, HA manages updates natively via the GHCR image — no local git workflow.

---

### The options→env bridge (run script)

The HA **Configuration** tab writes an options JSON that the s6 service runner
`rootfs/etc/services.d/ecoflow-panel/run` translates into environment variables the Node
server reads. The runner is a `#!/usr/bin/with-contenv bashio` script; it `set -e`, exports
each var via `bashio::config '<KEY>'`, then `cd /app/server && exec npm start`.

#### Fixed (non-configurable) env set by the runner

These are hard-coded in `run`, not exposed as options:

```sh
PORT=8787
HOST=::                      # bind all interfaces, IPv6-capable
DB_PATH=/data/ecoflow.db
WEB_DIST_PATH=/app/web/dist
SSH_HOST=::
SSH_HOST_KEY=/data/ssh_host_ed25519_key
```

`SUPERVISOR_TOKEN` is injected automatically by the Supervisor and inherited by the Node
process (not re-exported).

#### ★ The two boolean conventions — do not flip them

The runner emits booleans in **two different formats** depending on which env var the server
expects. This is deliberate; changing one to the other silently breaks the feature (the
server's parser only recognizes its own convention).

**Numeric `1`/`0`** — used for:
`SSH_ENABLED`, `TELNET_ENABLED` (its deprecated alias), `NOTIFY_RESOLVED`, `NOTIFY_CRITICAL_BYPASS_DND`, `NWS_ENABLED`, `MQTT_DISCOVERY_ENABLED`

```sh
if bashio::config.true 'SSH_ENABLED'; then export SSH_ENABLED=1; else export SSH_ENABLED=0; fi
```

**String `true`/`false`** — used for:
`BROADCAST_ENABLED`, `BROADCAST_USE_PRE_ANNOUNCE`, `CRITICAL_BREAKS_QUIET_HOURS`,
`BROADCAST_BILINGUAL`, `GRID_AVAILABLE`, `BATTERY_SOC_ALARM_ENABLED`,
`BATTERY_RUNWAY_ALARM_ENABLED`, `LOAD_SHEDDING_ADVISORY_ENABLED`,
`NIGHT_CHARGE_ADVISOR_ENABLED`, `NIGHT_CHARGE_NOTIFY_ON_HOLD`, `TARIFF_APS_RATES_CONFIRMED`

```sh
if bashio::config.true 'BROADCAST_ENABLED'; then export BROADCAST_ENABLED=true; else export BROADCAST_ENABLED=false; fi
```

All other options with a default are exported verbatim as strings (`$(bashio::config 'KEY')`).
The schema-only keys (optional, with no `options:` default; every key added since v1.191.0
takes this form) are exported only while they have a value
(`if bashio::config.has_value 'KEY'; then export KEY=…; fi`), so an unset or cleared field
leaves the variable absent, never the string `null`, and the server takes its unchanged path.
`SITE_LOCATION_FROM_HA` and `TARIFF_RATES_CONFIRMED` among them pass `true`/`false` through
verbatim, and their readers count only `true`.

The run script and the code apply four truthiness conventions between them (`!== '0'`,
`=== 'true' || === '1'`, `!== 'false'`, `!(=== 'false' || === '0')`). The option table in
`server/src/config.ts` carries each key's export form and its reader's rule, and
`server/test/optionsEnvBridge.test.ts` holds the run script, `config.yaml` and the table to
each other: every schema key has a row, every option row is exported, a schema-only key only
under `has_value`, and the script's boolean form matches the reader's rule.

#### Startup guards in the runner

- **Missing credentials fail fast:** if `ECOFLOW_ACCESS_KEY` or `ECOFLOW_SECRET_KEY` is
  empty, the runner logs `bashio::log.fatal`, `sleep 30`, then `exit 1` — the sleep prevents
  HA restart-looping the fatal message off the top of the Log tab.
- **Write-debug warning:** if `WRITE_DEBUG_TOKEN` has a value, the runner logs a warning that
  `POST /api/device/send-command` is enabled.
- **Broadcast confirmation:** if `BROADCAST_ENABLED`, logs `broadcast: enabled (targets: …)`.
- **Start line:** `Starting Power (ecoflow_panel) on :8787 (ssh <1|0>:<port>, telnet alias <1|0>:<port>, db /data/ecoflow.db)…`, then `exec npm start`.

---

### Full config.yaml option reference

The option table, one row per option with its default and schema, is
[docs/guide/options.md](../guide/options.md). It lists every `schema:` key: those with an
`options:` default, and the schema-only optional keys, which have none and appear on the
Configuration page under **Show unused optional configuration options**; each of those rows
states what Power does while the key is unset. What a home other than the reference plant sets
is listed in [your home](../guide/your-home.md).

---

### Security posture

The design principle: **read endpoints are open; every write is gated.** Read endpoints
(snapshot, history, forecast) are unauthenticated by design, and the binding reason is
the audible alarm path, not any browser client: `/audio-render/*` and `/chimes/*` are
plain static routes with no auth preHandler, and `BROADCAST_AUDIO_BASE` defaults to the
add-on's own host, so Home Assistant media players, Music Assistant, and the SIP
intercom all fetch klaxon and TTS WAVs unauthenticated at alarm time.
★★★ **Do not gate these reads: a 401 to a speaker is a silent alarm.** Writes require
one of three credentials, plus an extra lockdown on the raw device-command path. Defense-in-depth is layered on top with an
AppArmor profile.

#### Write-auth gate (`requireWriteAuth`, `server/src/auth.ts`)

Built by `createAuth({ host, port, log })` at boot. Applied as a Fastify `preHandler` on
every POST/PUT/DELETE route since v1.187.16, except the two loopback-only backup-hook routes
(`POST /api/internal/backup-window/{pre,post}`, v1.187.20), which answer only a loopback TCP peer
(`requireLoopbackPeer`) because the Supervisor's `backup_pre`/`backup_post` hook has no token. Until then two routes were
open: `POST /api/alerts/outcome` (the alert-feedback log, which also updates the online
pack-risk model) and `POST /api/energy-history/backfill` (a bounded background vendor-history
fetch that writes the vendor ledger). `server/test/writeRoutesGated.test.ts` scans every
`app.post`/`put`/`patch`/`delete` registration in `index.ts` and fails if one lacks the gate, and
since v1.187.20 also every registration in any server module (template-literal paths included),
accepting `requireWriteAuth` or `requireLoopbackPeer` (harness `scripts/mutate-v1187-16.mjs`, W-i–W-iii). The dashboard's outcome buttons reach the route
through Ingress or same-origin, like every other dashboard write.

It is also applied on the admin GETs `/api/writes/log`, `/api/admin/addons` and `/api/broadcast/discover`. A request is accepted if **any** of three conditions hold:

1. **HA Ingress** — `req.headers['x-ingress-path']` is present **AND** `isSupervisorSource(req.ip)`
   is true. The header alone is forgeable from the directly-published `:8787` LAN port, so the
   TCP peer is additionally pinned to the Supervisor network `172.30.32.0/23`
   (regex `^172\.30\.3[23]\.\d{1,3}$`, IPv4-mapped-IPv6 normalized). `req.ip` is the raw,
   unspoofable socket peer because Fastify runs with **trustProxy OFF** — so a client-supplied
   `X-Forwarded-For` cannot fake it. **Both** conditions must hold, closing the LAN-forge bypass.
2. **Same-origin** — `req.headers.origin` is in the same-origin allow-list built by
   `buildSameOrigins(host, port)`: `http(s)://{host}:{port}`, `http(s)://homeassistant.local:{port}`,
   `http(s)://localhost:{port}`, `http(s)://127.0.0.1:{port}`, `http(s)://[::1]:{port}`, plus every
   exact origin listed in `TUI_TRUSTED_ORIGINS` (v1.47.3). A trusted origin therefore satisfies this
   condition for every write, not only the `/console` upgrade. It also passes CORS and the `/ws` and
   `/console/ws` origin checks.
3. **Explicit token** — `req.headers['x-panel-write-token']` equals the bootstrap token
   (constant-time compare via `tokenEquals`, which does a length-independent `timingSafeEqual`
   even on length mismatch to avoid leaking token length by timing).

Otherwise returns `401 {"error":"write-auth-required", "hint":"set X-Panel-Write-Token header or use HA ingress"}`.

#### Write token bootstrap (`loadOrCreateWriteToken`)

- Reads `PANEL_WRITE_TOKEN` from env if present and ≥16 chars.
- Otherwise reads `/data/panel-write-token.txt` (path = `resolve(dataDir, 'panel-write-token.txt')`,
  `dataDir` defaults to `DATA_DIR` env or `/data`).
- If absent/unreadable/too short, generates a fresh `randomUUID()` and persists it
  **mode-0600** (`writeFileSync(..., {mode:0o600})` + a best-effort `chmodSync(0o600)`).
- TOCTOU-hardened (CodeQL `js/file-system-race`): reads directly and catches ENOENT rather
  than `exists→read→write`.
- **Rotate the token** by deleting `/data/panel-write-token.txt` and restarting the add-on.

#### CORS allow-list (`corsOriginCallback` / `isAllowedOrigin`)

`@fastify/cors` is registered with the callback form. Same-origin requests (no `Origin`
header, curl, server-side) pass. Cross-origin requests pass only if the origin is:
- in the same-origin set, **or**
- in `HA_DASHBOARD_ORIGINS` (`homeassistant.local` on `:8123` and `:8787`, `homeassistant` on `:8123`), **or**
- matched by `LAN_ORIGIN_RE`: an IPv4 literal in the RFC 1918 ranges (`10.x`, `192.168.x`,
  `172.16–31.x`) or loopback `127.x`, or a single-label `<name>.local` host (`a.b.local` does not
  match), on **any port or none**. Since v1.47.2 the port is optional, so HA behind a reverse
  proxy, or the companion app on the default port, matches.

Anything else gets no `Access-Control-Allow-Origin` header and the browser blocks the JS from
reading the response.

#### Write-debug lockdown — `POST /api/device/send-command`

The raw-command debug path is the most dangerous endpoint (arbitrary EcoFlow commands). It is
gated by **five** layers (`server/src/index.ts`, `server/src/ecoflow/commands.ts`):

1. `requireWriteAuth` preHandler (ingress / same-origin / token).
2. **Feature flag** — `isWriteDebugEnabled()` returns false unless `WRITE_DEBUG_TOKEN` env is
   non-empty; otherwise `403 {"error":"write-debug disabled (set WRITE_DEBUG_TOKEN env to enable)"}`.
3. **Second token** — the request must carry header `x-write-debug-token` matching
   `WRITE_DEBUG_TOKEN` via constant-time compare (`checkWriteDebugToken`); else `401`.
4. **cmdSet allow-list** — `cmdSet`/`cmdCode` must match `ALLOWED_CMD_SETS`:
   `PD303_APP_SET` (SHP2 exact), `WN511_PORTABLE_` / `WN511_BLE_FUNC_` (DPU-family prefixes).
   Rejections are audit-logged and return `400 cmdSet-not-allowlisted`.
5. **Params shape guard** (`paramsObjectOk`) — must be a non-array object, max depth 5, max 100
   total keys, max 1 KB serialized; plus a **per-SN cooldown** `SEND_CMD_COOLDOWN_MS`
   (env, default `30000` ms) returning `429` while cooling down.

The non-debug device writes all use the documented `PD303_APP_SET` shape and the audit log:
- `POST /api/device/refresh-cloud/:sn`: a true no-op cloud-presence refresh that re-sends the current `backupReserveSoc`. Cooldown `REFRESH_COOLDOWN_MS = 30_000` per SN.
- `setBackupReserveSoc` (audit action `night-charge-reserve`, 5-min per-SN cooldown, integer within the reserve write envelope). Used by the supervised night-charge reserve write (v1.50.0, §15.8b) and, since v1.114.0, by the owner reserve floor `POST /api/reserve-floor`. That route requires write-auth, shares a 10/h limit, and is refused with 409 while a night-charge write holds the reserve up (§12h).
- `setChannelForceCharge` (audit action `charge-now-ch{n}`, slot 1–3, 5-min cooldown; since v1.186.0 an OFF is limited only by earlier OFFs). Used by the Charge Now responder's OFF (`CHARGE_NOW_RESPONSE: supervised`, v1.84.0, §12c) and by the night force-charge ON/OFF (v1.165.0).
- `setForceChargeCeiling` (audit action `force-charge-ceiling`, `foceChargeHight` 80–100, 5-min cooldown). Used by the night force-charge ceiling sync (v1.165.0).

`POST /api/night-charge/cancel` (write-auth) disarms or reverts tonight's supervised write: the cost leg by default, or the leg an optional `{ leg: 'cost' | 'backup' }` body names (400 for any other value).

#### Audit log (`server/src/writeLog.ts`)

Every write action is appended as JSON Lines to `/data/writes.log` (path override:
`WRITE_LOG_PATH` env, default sibling-of-DB). Each row:
`{ ts, action, sn, params, source:{ip,ua}, outcome, code, message, durationMs }`.
Content is re-serialized through an explicit typed shape (`sanitizeWriteLogEntry`) — known
fields only, finite-coerced numbers, control-stripped/length-bounded strings (CodeQL
`js/http-to-file-access`); the path itself is a fixed constant, never request-influenced.
`GET /api/writes/log?limit=N` (default 50, clamped 1–500) tails it, re-reading at most
256 KiB — and is itself behind `requireWriteAuth` because it can leak source IPs and attempted
command shapes.

#### In-process rate limiting

`makeRateLimiter(max, windowMs)` — a dependency-free fixed-window limiter returning `429`
when exceeded. `chimeWriteRateLimit = makeRateLimiter(30, 60_000)` guards the chime
upload/delete/config write routes (bounds CPU for WAV normalization + disk churn; addresses
CodeQL `js/missing-rate-limiting`). Each limiter is one shared bucket per route group, not per client:
- `exportHaRateLimit` 6/h: `POST /api/energy-history/export-ha`.
- `dbExportRateLimit` 6/h: `POST /api/db-export`.
- `latchWriteRateLimit` 10/h: `POST /api/reserve-floor` and `POST /api/defective-packs/clear`.
- `latchReadRateLimit` 60/min: `GET /api/defective-packs` and `GET /api/db-export`.
- `broadcastConfigRateLimit` 30/min: `PUT /api/broadcast/config`.
- 120/min read limiters on `GET /api/broadcast/config`, `GET /api/alert-settings`, and `GET /api/chimes` + `GET /api/chime-config` (one shared bucket).

WebSocket inbound frames are capped at `maxPayload = 64 KiB`.

#### AppArmor profile (`ecoflow_panel/apparmor.txt`)

Loaded by Supervisor as the container's LSM profile. The file declares `profile addon_ecoflow_panel`, but the Supervisor renames the profile to the installed add-on's slug (`<repository-hash>_ecoflow_panel`) when it loads it. Look for that name in `/sys/kernel/security/apparmor/profiles` and in audit records. It bumps
the HA security rating and confines the process even if a Fastify endpoint is exploited.

- **Capabilities allowed (v1.187.15):** `chown`, `dac_override` only. Every process runs as
  root and no service switches user, so the old list (`net_bind_service`, `setuid`, `setgid`,
  `dac_read_search`, `fowner`, `fsetid`, `kill`, `sys_chroot`) granted capabilities nothing used.
- **Network (v1.187.15):** `inet`/`inet6` `stream` and `dgram` (TCP; UDP for DNS), `unix` (s6
  IPC), `netlink raw` (Node's interface listing) — no blanket `network,`, no raw or packet sockets.
  In use (2026-10-11): listen 8787; out to EcoFlow MQTT 8883, HA's broker 1883, HA/Supervisor 80,
  HTTPS 443, Wyoming TCP.
- **Capabilities explicitly denied:** `sys_admin`, `sys_module`, `sys_rawio`, `sys_ptrace`,
  `sys_boot`, `sys_time`, `mac_admin`, `mac_override`.
- **Denied file ops:** reading `/etc/shadow`, `/etc/gshadow`, `/root/**`, `/home/**`,
  `/etc/ssh/**`; writing `/proc/sys/**`, `/sys/**`, `/proc/sysrq-trigger`; mount/umount/
  pivot_root/remount; ptrace.
- `/data/**` is `rwk` (SQLite WAL/shm need `k`); `/tmp`, `/var/tmp`, `/run` are `rwk`.
- **Write-locked (`deny … wl`):** `/app`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/init`
  (v1.7.2) and, since v1.187.15, `/etc`, `/package`, `/command` and `/var/{cache,lib,log,spool,opt,mail,local}`
  — no file on the container's root filesystem changes after start.
- **Review 2026-10-11 (v1.187.15), how it was done:** the narrowed profile was loaded in COMPLAIN mode
  in place on the running add-on (`apparmor_parser -r`, self-reverting at the next restart) and on an
  isolated container of the released image (sanitized options, dummy EcoFlow keys, no Supervisor
  token, the new write-locks as `audit deny` so a block would be logged); the add-on booted, served
  its API, created its database and spawned its workers, and the host audit journal held no
  ALLOWED/DENIED record for either. The final profile was compiled fresh (`apparmor_parser -T -Q -K`)
  before shipping. Invariants pinned in `apparmorProfile.test.ts` (harness `mutate-v1187-15.mjs`).

★ Two hard-won footguns baked into the profile comments (do not "clean up"):

1. **KEEP the blanket `file,` rule.** v1.7.0 replaced it with a per-path allow-list that had
   `/init ix` (execute only), but s6-overlay **re-opens `/init` for READING** during
   shutdown/restart → `/bin/sh: can't open '/init': Permission denied` crash-loop → whole
   add-on (and alarm) down. Reverted v1.7.1. v1.7.2 instead keeps `file,` (so no read/exec can
   ever be denied) and layers **write-immutability** deny rules on the code/binary/lib dirs
   (`deny /app|/usr|/bin|/sbin|/lib|/lib64|/init … wl`) — closing the dominant CWE-732
   persistence vector without any read-denial risk.
2. **★★ The write-mask is `wl`, NOT `wal`.** The append bit `a` and write bit `w` are mutually
   exclusive in a single rule on the stricter apparmor parser HAOS ships on **kernel 6.18**.
   v1.7.2–v1.9.0 shipped `wal`, which parsed on the old feature set but the compiled result was
   cached; a host reboot into the new feature set forced a fresh compile that rejected `wal`
   (`Conflict 'a' and 'w' perms are mutually exclusive`) → profile failed to load → container
   couldn't start → **whole alarm DOWN** until hot-patched (v1.9.1 fix). **Never combine `a`
   with `w`; validate any mask change with `apparmor_parser -T -Q` (fresh, cache-skipping)
   before shipping.**

Diagnostic note: on Home Assistant OS, AppArmor records go to the host's audit journal
(`journalctl _TRANSPORT=audit` on the host), not to `/var/log/audit/audit.log` and not to `dmesg`.
An explicit `deny` rule is silent and logs nothing. Only an `audit deny` rule, or an operation that
no allow rule covers, is recorded. That is why the v1.187.15 review loaded the new write-locks as
`audit deny`.

#### Image signing / rating ceiling

CodeNotary (`vcn`) image signing was set up in v0.9.45–47 then **removed** in v0.9.48: the OSS
`vcn` project is dead (repo 404, amd64-only image SIGSEGVs under QEMU, native binaries gone),
and HA's own addons repo dropped it too. Net: the security-rating ceiling for this add-on is
**~7** (with the v0.9.44 AppArmor profile), not 8. `CN_USER`/`CN_PASSWORD` repo secrets are
unreferenced and harmless.

---

### Port & ingress map

| Port | Protocol | Purpose | Auth |
|------|----------|---------|------|
| `8787/tcp` | HTTP | Web dashboard + REST API + WebSocket (`/ws`) | Reads open; writes via `requireWriteAuth`. Also the `ingress_port`. |
| `2323/tcp` | SSH | "Control-room" TUI | Password login with `TUI_USERNAME` / `TUI_PASSWORD` (§11 2.3); every login is refused until a password is set. Default OFF (`SSH_ENABLED=false`; `TELNET_ENABLED` is a deprecated alias that also turns it on). The browser console at `/console` on `:8787` uses the same credentials behind its login card. The host key is `/data/ssh_host_ed25519_key`; its SHA256 fingerprint is on the startup log line. |

The server listens on `SSH_PORT` inside the container, and the manifest publishes container port
2323. A different `SSH_PORT` (or `TELNET_PORT`, while `SSH_PORT` is at 2323) therefore moves the
listener off the published port; to reach the console on another host port, change the host side
of `2323/tcp` in the add-on's **Network** tab and leave `SSH_PORT` at 2323.

**Ingress:** with `ingress: true` / `ingress_port: 8787`, the Supervisor reverse-proxies the
same server into the HA sidebar ("Power"), authenticated by HA's session (visible in the HA
mobile app). Ingress traffic carries `X-Ingress-Path` and originates from `172.30.32.0/23`, so
it satisfies `requireWriteAuth` condition #1 automatically. Direct LAN access on `:8787` still
works in parallel.

---

### Container build (Dockerfile)

3-stage build:
1. **webbuilder** (`node:22-alpine`) — `npm ci` + `npm run build` the React web UI. Tailwind CSS 4's scanner (`@tailwindcss/oxide`), Lightning CSS and Vite's bundler (rolldown) are native packages; the lockfile carries their `linux-x64-musl` and `linux-arm64-musl` builds, one per image arch (v1.187.7).
2. **serverdeps** (`node:22-alpine`) — `npm ci` the server deps (`tsx` is a runtime dep, not
   just dev — the server runs TS directly).
3. **runtime** (`FROM ${BUILD_FROM}` — the HA Alpine+s6+bashio base) — `apk add nodejs npm
   ca-certificates tzdata`, copy `server/`, the built `web/dist`,
   and `rootfs/` (the s6 service and the backup hook). `chmod a+x` the run script and the hook. `EXPOSE 8787 2323`.

Runtime ENV baked in: `NODE_ENV=production`, `PORT=8787`, `HOST=0.0.0.0`, `DB_PATH=/data/ecoflow.db`,
`WEB_DIST_PATH=/app/web/dist`. Build metadata (`BUILD_VERSION`, `BUILD_DATE`, `BUILD_REF`) is
promoted from ARG to ENV (v0.14.0) so `/api/version` reports the real release instead of "dev".

**Base image is digest-pinned** in three files that must stay in lockstep (v1.7.2, CWE-1357):
`build.yaml`, `.github/workflows/ci.yml`, `.github/workflows/images.yml` — all reference
`ghcr.io/home-assistant/{arch}-base:3.21@sha256:…`. Update the digest deliberately on a base bump.

**Every GitHub Action is pinned to a full commit SHA** with its version in a comment. v1.187.16
pinned the last three floating tags: `actions/setup-node` in `ci.yml`'s advisory job and
`actions/checkout` in `release.yml` and `tag-release.yml`, the two workflows with write
permissions.

**Every job runs on a pinned runner image** (`ubuntu-26.04`, and `ubuntu-26.04-arm` for the
aarch64 image build, since v1.187.20; `codeql.yml` stays on `ubuntu-24.04` because CodeQL's system
requirements list only Ubuntu 22.04 and 24.04), never `ubuntu-latest`. GitHub moves `ubuntu-latest` to Ubuntu 26.04 in a
rollout from 2026-10-19 to 2026-11-19 (actions/runner-images#14748); that one move would change
python3, Docker, the docs jobs' pandoc and LibreOffice, possibly coreutils, and CodeQL's platform
(its supported list names only Ubuntu 22.04 and 24.04), under every job at once. Moving to a newer
image is a one-commit label change, made deliberately: v1.187.20 moved every job to 26.04 after a
trial of all fifteen checks (#520, pandoc 3.7.0.2, LibreOffice 26.2.6) and of the native per-arch
image builds (#523) on it. `server/test/workflowRunners.test.ts` fails on a `-latest` label, a
quoted or matrix `-latest` runner, a job without `runs-on`, and a CodeQL runner outside the
versions CodeQL supports.

---

### Release & publish pipeline

The release is driven by a **`version:` bump in `config.yaml`** landing on `main`. The `main`
branch is governed by the `BranchAuth` ruleset (PR + verified signatures + CodeQL), so no
workflow pushes to `main` directly — everything goes through an auto-merging PR whose
squash-commit is GitHub-web-flow-signed.

#### Step 1 — `release.yml` (manual dispatch)

Trigger from **Actions → Release → Run workflow**. Inputs: `bump` (patch/minor/major, default
patch), `version` (explicit override), `notes` (markdown; auto-generated from the commit log
since the previous tag if empty). It:
1. Parses the current `version:` from `config.yaml` and computes the next version from the
   higher of that and the highest strict `vX.Y.Z` tag (a tag can sit above `main`'s version).
   It refuses a version that is not strict `X.Y.Z`, is already tagged, or is not above both, so
   re-runs are idempotent.
2. Builds release notes.
3. `sed`-bumps `version:` in `ecoflow_panel/config.yaml` and prepends a
   `## <version>` section to `ecoflow_panel/CHANGELOG.md`, then runs
   `scripts/roll-changelog.mjs`. Home Assistant's Changelog dialog renders the whole file, so the
   script keeps the newest releases that fit in 32 KiB and moves older ones, unedited, to the top of
   `CHANGELOG-ARCHIVE.md`. CI fails once `CHANGELOG.md` passes 48 KiB. The new section's heading is
   the bare version (`## X.Y.Z`): Home Assistant's update dialog shows only the sections between the
   installed and the new version when the headings are exactly the versions, and the whole file
   otherwise.
4. Commits, runs `scripts/check-release-pr.py` with `BASE_REV=origin/main` (CI does not run on a
   PR opened with `GITHUB_TOKEN`), then opens PR `release/vX.Y.Z` → `main` with commit subject
   **`Release vX.Y.Z`** and enables `--squash --auto --delete-branch`. (The branch commit is
   unsigned; only the signed squash commit lands on main.)

#### Step 2 — CI checks gate the PR

`ci.yml` runs on every push/PR to `main`:
- `Type-check server` / `Type-check web` (`tsc --noEmit`).
- `Type-check server tests` (`tsconfig.test.json`, src + test).
- `Mutant anchors resolve` (`scripts/check-mutant-anchors.mjs`).
- `Server tests`: `npm test`, then `scripts/check-doc-claims.mjs` against the pass count and the engine index ([Appendix A.13](A-feature-inventory.md#a13-engine-index)): each row's file must declare its identifier in code (a mention in a comment or a string does not count), every row must have the header's cell count (a pipe inside a cell is written `\|`), the index's count sentence (total, thread tallies, strict reading and its live and waiting split), the README's group counts and its count of write-capable engines must equal the rows, the README's floor must sit below the strict reading, and on the swept surfaces (the README, the add-on's README, documentation and configuration, the image labels, the web manifest, and every guide and reference page) a count written directly before "engines" or "analytics engines", bold or not, must be the index total or the README's floor, in digits and with no ~, ≈, qualifier or trailing +, and no sentence may make the engines as a whole the subject of a verb such as run, live or execute that places them in the worker or on the main thread. A count elsewhere in a sentence, or a subject narrowed to some of the engines, is not read; [`scripts/lib/engineIndex.mjs`](../../scripts/lib/engineIndex.mjs) lists the exact wording. The suite has gated the PR since v1.58.0.
- `No personal data in the tree` (`scripts/check-no-secrets.py`).
- `Dependency advisories` (`scripts/check-npm-audit.mjs`).
- `Validate add-on config + translations`.
- `Dockerfile smoke build (amd64)`.
- `Build documentation (.docx + .pdf)` (bounded; see Step 4).

`release-pr.yml` runs on every pull request to `main` (`opened`, `synchronize`, `reopened` and
`edited`, so a title edit re-runs it): `Release PR declares the version it names`
(`scripts/check-release-pr.py`). It checks out with `fetch-depth: 0` and compares the version in
`config.yaml` before and after GitHub's test merge (`HEAD^1` against `HEAD`), so a branch cut
before the last release is not read as a downgrade. It fails: a version change under a title other
than `Release v<new>`; a `Release vX` title that changes no version (v1.130.0, or a second release
PR racing one that already merged); for a one-commit PR, a commit subject starting `Release v` that
names another version or changes none (the repository's squash default lands a one-commit PR with
its commit's subject, not the title, and `tag-release.yml` judges that subject); a version that is not strict `X.Y.Z` or is declared twice; a
downgrade; a version already tagged or below the highest strict tag; and a missing CHANGELOG
section, matched with `images.yml`'s exact `^## v?X\b`. It fails closed when `HEAD` is not a merge
commit, unless `BASE_REV` names the revision to compare against (as `release.yml` does). The job
ran in `ci.yml` until v1.187.17; its name, the required check's context, is unchanged.

Required before a merge: since 2026-10-11 branch protection on `main` requires every check above — the
ten `ci.yml` checks (the type-check job runs for server and web), `release-pr.yml`'s release-PR check, `codeql.yml`'s three `Analyze (…)` jobs and the `CodeQL` result, fifteen in all
(branch protection's `strict` is off). The `BranchAuth` ruleset also requires `CodeQL`, and its status-check
rule requires the branch to be up to date with `main`; repository admins may bypass the ruleset. A job
that is renamed or removed must have its old name replaced or removed in that list, or every pull
request waits on a check that never reports; a new job is not required until it is added.

`codeql.yml` analyses `actions`, `javascript-typescript` and `python` on every push/PR and weekly.
It fails on an `error`-level result or a `security-severity` ≥ 7.0 (`.github/scripts/check-sarif.mjs`).
`images.yml`'s `test` job re-runs the suite on the tag.

#### Step 3 — `tag-release.yml` (post-merge reconciler)

Home Assistant offers whatever `version:` `config.yaml` declares on `main`, and a lower version is
offered too: Supervisor's `need_update` is `version != latest_version`, and auto-update installs it.
`tag-release.yml` therefore runs on **every** push to `main` (no paths filter, no subject gate) and
on `workflow_dispatch`, one run at a time (`concurrency: tag-release`, `cancel-in-progress: false`,
`queue: max`). Event data reaches its script only through `env` (`BEFORE`, `HEAD_MSG`,
`EVENT_NAME`). The script first re-fetches `main` and every tag, because `actions/checkout` forces
`origin/main` to the run's own commit and runs can execute out of order. It then decides, in order:

1. The commit is not on `main` (a dispatch from another branch), or `config.yaml` declares a
   version that is not strict `X.Y.Z` or declares it twice → red run.
2. The subject starts `Release vX` but the push did not change the version → red run (the run
   continues, and still tags or re-dispatches what it should).
3. `main` has since moved to another version → notice, exit 0 (that push's run reconciles it).
4. `vV` is already tagged: at this commit or a later commit on `main` → fine; off `main` → red run.
   At an earlier commit it is judged on the state: while a higher strict tag exists (`main` was
   reverted to an older release, which HA offers as a downgrade) every push and dispatch is red until
   `main` moves above it; and a push from another released version to it (a reused number) is red.
   Leaving a version that was never tagged (a pre-release spelling, or a release whose run was
   superseded) for the released one is not. If it has no GitHub Release, a re-run
   (`GITHUB_RUN_ATTEMPT` > 1) or a manual dispatch re-dispatches `images.yml`; a first attempt only
   warns, since `images.yml` may still be running. Only a 404 from the Release lookup
   (`gh api repos/…/releases/tags/vV`) counts as no Release; any other lookup failure is a red run,
   never a re-dispatch that would rebuild a sealed version's images.
5. `vV` is untagged and not above the highest strict tag → red run, nothing tagged.
6. Otherwise it creates the annotated tag and pushes it, then
   **`gh workflow run images.yml -f version=X.Y.Z`**. It tags this commit when the push changed the
   version; otherwise (a lost run, or a dispatch) it tags the commit that brought the version to
   `main`, found by a first-parent walk. A bump under a subject other than `Release vX` is tagged
   with a warning; a subject naming another version is a red run after tagging.

An ordinary push (version unchanged, tagged and released) is a no-op. A tag pushed with the default
`GITHUB_TOKEN` won't trigger other workflows (GitHub's recursion guard), so it dispatches
`images.yml` explicitly, after the tag push. Permissions: `contents: write`, `actions: write`;
`timeout-minutes: 10`. Before this, the workflow ran only for a push that touched `config.yaml`
with a subject starting `Release v`: a bump merged under another subject (v0.54.1) was never
tagged (its Release was made by hand), and a `Release v` merge without the bump (v1.130.0) was
never evaluated.
`server/test/tagRelease.test.ts` and `tagReleaseEdges.test.ts` run the script in temporary
repositories against a stub `gh`; `releasePrCheck.test.ts` runs `check-release-pr.py` against real
test merges (harness `scripts/mutate-v1187-18r.mjs`).

#### Step 4 — `images.yml` (build + publish + release)

Triggers on `v[0-9]+.[0-9]+.[0-9]+` tag push, or manual `workflow_dispatch` with a `version`
input. Its run name carries the version, and one run per version executes at a time
(`concurrency: images-vX.Y.Z`, `cancel-in-progress: false`), so a re-dispatch cannot race a running
build to `gh release create`. Jobs:
1. **resolve** — validate/normalize the version: strict `X.Y.Z`, as `tag-release.yml` tags.
2. **test** — checkout the tag, `npm ci`, `npm test`, `tsc --noEmit` on the server.
3. **build** (matrix aarch64 + amd64, each on its **native** runner: `ubuntu-26.04-arm` /
   `ubuntu-26.04` — no QEMU emulation, about a minute per arch vs 30–60 min under QEMU) — buildx build + push to
   `ghcr.io/<owner>/{arch}-ecoflow-panel` as both `:{version}` and `:latest`. Base images
   digest-pinned. GHA cache uses `ignore-error=true` so a flaky cache backend can't fail a release.
   There is no QEMU step: nothing runs a foreign-arch binary, and it only pulled `tonistiigi/binfmt`
   from Docker Hub on every job (`server/test/workflowNativeBuild.test.ts` fails if a matrix entry
   pairs a platform with the other arch's runner, or if the step returns). The Buildx setup step
   gets one retry after a 30 s pause, and a second failure fails the job: on the v1.187.12 release
   run (2026-10-10) a Docker Hub token timeout failed the amd64 job before it built, so the release
   job was skipped. On that run the `binfmt` pull recovered on its own retry; `setup-buildx-action`
   v4.1.0 pulled `moby/buildkit` once and failed. From v4.4.0 (now pinned) that action
   pre-pulls the BuildKit image itself, up to five attempts on a transient registry error, inside
   the outer retry. The build step still resolves its Dockerfile frontend and `node:22-alpine` from
   Docker Hub without a retry.
4. **release** — extract the version's `CHANGELOG.md` section and `gh release create` the
   GitHub Release (skipped if it already exists). The section header may be `## X.Y.Z` or
   `## vX.Y.Z`; if there is no section, the job fails instead of publishing a placeholder. The
   Release is marked Latest only when its tag is the highest strict `vX.Y.Z` tag, compared as
   numbers (`--latest=false` otherwise; GitHub decides if the lookup fails), so re-running an older
   version's release cannot demote a newer one, and a stray `v1.2.3-rc1` (which `sort -V` ranked
   above `v1.2.3`) does not count. **The Release appearing = "go ahead and update the host."**
   Permissions: `contents: write`, `packages: write`. The printable documentation (.docx and
   .pdf) is built first and attached at creation; those steps are best-effort
   (`continue-on-error`) and **bounded** (v1.187.3): each has `timeout-minutes` (pandoc 6,
   .docx 5, LibreOffice 10, .pdf 5), `apt-get` runs under `timeout` with
   `Acquire::Retries` / `Acquire::http(s)::Timeout`, and the docs tools under `timeout`, so a
   stall ends as a failed step the Release survives. The Release step itself is bounded
   (10 min) and not best-effort, and the job's bound (45 min) sits above the sum of its steps'
   bounds, so a docs step running to its limit cannot cancel the job. Before v1.187.3 nothing
   was bounded: `continue-on-error` covers a step that fails, not one that hangs, and a mirror
   stall in `apt-get update` ran the v1.187.1 release job into the 6 h platform limit, which
   cancelled it before the Release was created. Because a bounded step can be killed mid-write,
   a document is attached only when its build step's own `outcome` (before `continue-on-error`)
   is `success` and the file is non-empty, and the .pdf is rendered only from a .docx whose
   build succeeded: an immutable Release never seals a truncated asset. The images are pushed
   by `build` before this job starts. CI's `docs-docx` job (a hard PR gate) is bounded the same way,
   with a 40-min job limit above its steps' bounds. `server/test/workflowTimeouts.test.ts` holds
   these bounds. The CI job also drops the runners' first apt mirror (`azure.archive.ubuntu.com`)
   from `/etc/apt/apt-mirrors.txt` when another one is listed, and installs pandoc 3.7.0.2 from the
   upstream release `.deb`, checked against a pinned SHA-256, with apt as the fallback (a 12-min
   step): that mirror served the 29 MB package at about 39 kB/s on several runs. The release job
   still installs pandoc with apt.

First-time-only: toggle the two new GHCR packages from Private → Public so HA can pull anonymously.

#### Step 5 — deploy to the host

Because `config.yaml`'s `image:` key points at GHCR, HA Supervisor **pulls** the prebuilt
multi-arch image — it does **not** build on the host. Once the GitHub Release is out, in HA:
**Settings → Add-ons → Add-on Store → ⋮ → Check for updates**, open **Power**, click **Update**
(HA reads the bumped `version:` from `config.yaml` on `main` and drives the update-entity).

> Title the release PR `Release vX.Y.Z …` with the version above every `vX.Y.Z` tag (and, for a
> one-commit PR, give the commit the same subject: its squash merge lands with it);
> `release-pr.yml` fails it otherwise, or when the CHANGELOG section is missing. Whatever lands,
> `tag-release.yml` runs on the push and tags what `config.yaml` declares, or fails the run when
> that version cannot be published: HA already offers it, so a red `tag-release` run on `main` is
> a production event, not a cosmetic one. A bump merged under another subject is still tagged (with
> a warning). To recover a lost dispatch, re-run the `tag-release` job or dispatch it by hand.

---

### Operational runbook basics

#### Persistence — what lives in `/data`

`/data` is the `data:rw`-mapped volume; it survives restarts/updates. Key files:
- `ecoflow.db` — SQLite recorder (WAL mode → `.db-wal`/`.db-shm`).
- `panel-write-token.txt` — mode-0600 write token.
- `ssh_host_ed25519_key` — the SSH console's host key (mode 0600), generated on the first start with the console on.
- `site-location.json` — Home Assistant's home location, saved by `SITE_LOCATION_FROM_HA` and applied from the next start.
- `device-aliases.json` — optional display names by serial; `DEVICE_ALIASES` is merged over it, and it over the image's own file.
- `writes.log` — JSONL audit log.
- `audio/` — startup-generated klaxon WAVs (served at `/audio/*`).
- `audio-render/` — on-demand rendered klaxon+TTS announcements (served at `/audio-render/*`, `wildcard:true`).
- Operator-uploaded chimes dir (served at `/chimes/*`).
- `.night-charge-latch.json` / `.night-charge-plan.json` / `.night-charge-actuation.json` — the evening-job day latch, the persisted pre-window plan snapshot, and the restart-surviving supervised-write actuation record (§15.8b; the actuation file is what lets a raised reserve be found and reverted across a restart). `.night-charge-midday-shadow.json` holds the winter mid-day charge computed in preview.

#### First-run setup

1. Set `ECOFLOW_ACCESS_KEY` + `ECOFLOW_SECRET_KEY` in the **Configuration** tab → Save → Restart
   (the runner exits without them). Set `FORECAST_LAT`/`LON` (the defaults are a placeholder),
   then what else differs from the reference plant: [your home](../guide/your-home.md).
2. Devices populate from the REST poll within ~15–60 s (MQTT warms up after).

#### Common failure modes

- **"Missing required env var: ECOFLOW_ACCESS_KEY"** — set the key, Save, Restart.
- **`401` from `api-a.ecoflow.com`** — switch `ECOFLOW_API_HOST` to `api-e` (EU) / `api-us` (US).
- **Dashboard loads but no devices** — check the Log tab; the REST poll fills the snapshot in 15–60 s.
- **SSH refuses the connection or the login** — confirm `SSH_ENABLED` (or the deprecated `TELNET_ENABLED`) is on, `:2323` is exposed in the Network tab, and a `TUI_PASSWORD` is set: without one every login is refused, and the log says so. The startup log line carries the host key fingerprint to compare with the client's prompt.
- **The forecast card reads "Building the forecast — needs a little recorded history first."**
  (or the Solar tab's response card reads "Learning your arrays — needs a bit more paired
  sunlight + output history."). The learned solar model needs recorded daylight PV first; give it
  a day.
- **AppArmor profile change → container won't start / alarm dark.** There are two causes. A bad
  mask (e.g. `wal`) fails the profile compile, so the container cannot start. A wrong deny in the s6
  init trees compiles but makes init crash-loop. Validate with a fresh, cache-skipping
  `apparmor_parser -T -Q`, and read denials from the host audit journal (`journalctl
  _TRANSPORT=audit`). Explicit `deny` rules are silent, so boot-test new denies as `audit deny`.
  Since v1.187.15 `/command`, `/package` and `/etc` are write-locked (`deny … wl`); `/command` and
  `/package` are the s6 PID1 trees. The locks were added after that boot test (§12 AppArmor
  profile). A mistaken denial in those trees is an *invisible* init crash-loop, so any further
  change to them needs the same boot test.
- **Errored add-on after a bad boot**: updating an add-on that is already in the `error` state
  installs the new image but does not start it. Start it explicitly, with the add-on page's Start
  button or the Supervisor `POST /addons/<slug>/restart`.
- **★ Physical power to the host:** on the reference plant the host's circuit was observed losing power for
  84–187 min/day → the alarm goes dark and cannot report itself; only the out-of-band heartbeat
  (`HEARTBEAT_URL`, §13.0c) notices, from outside the house. The monitor must be on an always-on
  circuit. `HOST_POWER_ENTITY` (a `binary_sensor` device_class=problem) can warn on a
  browning-out host before it goes fully dark.

#### Rotating secrets

- **Write token:** delete `/data/panel-write-token.txt`, restart. A fresh UUID is generated.
- **Write-debug path:** clear `WRITE_DEBUG_TOKEN` in Configuration to disable
  `POST /api/device/send-command` entirely (default state).
- **SSH host key:** delete `/data/ssh_host_ed25519_key`, restart. A fresh ed25519 key is generated
  and its fingerprint logged; clients warn that the host key changed.


---

**Chapter 12 addenda (v1.82.0 onward).** Subsystems and release-scoped notes added to this
chapter after it was first written: the vendor API notes, then 12a–12q in letter order.

### Vendor API notes (documented, not all used)

From the official EcoFlow IoT Open Platform pages (DELTA Pro Ultra = YJ751,
Smart Home Panel 2 = PD303), verified against live `quota/all` payloads on
2026-08-17. Read-only keys in use are listed with their projection fields in
the sections above. Documented but **not used yet**:

- **Historical data**: `POST /iot-open/sign/device/quota/data` with PD303 codes
  (`PD303-App-LOAD-…-Week`, `PD303-Dashboard-Circuits-Line-Week` with
  `energy_hour_{grid,oil,bak}_ch{1-12}`, battery in/out, grid, solar,
  generator, savings). Per-circuit energy split by SOURCE. **In use since v1.82.0**: the
  vendor energy ledger (12a) fetches it daily via `ecoflow.getQuotaData`, and
  `GET /api/debug/vendor-history-probe` (12f) probes it.
- **Targeted reads**: `POST /iot-open/sign/device/quota` with
  `params.quotas: [...]` returns single keys (e.g. `backupReserveSoc`) —
  a lighter readback than `quota/all` if the actuator ever needs one.
- **Control (write) command codes** — documented, deliberately unused beyond
  `PD303_APP_SET` `backupReserveSoc` (night charge, owner floor), `ch{n}ForceCharge`
  (Charge Now responder OFF since v1.84.0; night force-charge ON/OFF since v1.165.0) and
  `foceChargeHight` (force-charge ceiling sync/restore, v1.165.0): `ch{n}EnableSet`,
  `stormIsEnable`, `epsModeInfo`, `chargeWattPower`,
  `masterCur`, `oilMaxOutputWatt`, per-branch `setAmp`/`chName`/`loadSta`;
  YJ751: `YJ751_PD_AC_CHG_SET` (`chgC20Watts`/`chg5p8Watts`),
  `CHG_SOC_MAX_SET`/`DSG_SOC_MIN_SET`, `AC_DSG_SET`, `AC_OFTEN_OPEN_SET`,
  standby timers. Any future write goes through the audited write framework
  with the v1.79.0 readback pattern.

### 12a. Vendor energy ledger (`energyHistory.ts`, v1.82.0)

Daily job (06:35-09:00 site-time window, day-latched in the sidecar, restart
safe) fetching yesterday's SHP2 historical-data record: `homeWh`, `gridWh`,
`solarWh`, `generatorWh`, `batteryInWh`/`batteryOutWh` (extra 1/2), and 12
per-circuit rows split by source (`energy_hour_{grid,oil,bak}_ch{n}`).

Reconciliation scores LIKE BASES ONLY (`driftPct`, signed toward the vendor,
null under 100 Wh on either side): vendor home ↔ local `fleet.panelLoadWh`,
vendor solar ↔ local `fleet.pvWh` (both from the analytics `totals` report
over the same site-time day). Grid/generator/battery are recorded unscored —
see the two-grid-quantities note in §7.0.2. No alert is emitted from this engine.

State: `/data/vendor-energy-daily.json` (atomic writes, 120-day cap, corrupt
file = start fresh). API: `GET /api/energy-history[?day=]` (includes the
advisory `empiricalRte` summary since v1.85.0),
`GET /api/debug/vendor-history?day=` (live, unstored),
`POST /api/energy-history/backfill?days=N` (bounded manual backfill; write-auth since v1.187.16).
**v1.85.0**: the morning job also backfills up to 10 older missing days
(60-day horizon, per-day persistence) and reports empirical RTE
(`computeEmpiricalRte`: qualifying days need ≥ 1 kWh vendor battery-in;
≥ 5 qualifying days before any number is reported; advisory only —
`DISPATCH_RTE` is untouched until the vendor's battery-in semantics have a
proven baseline). Failure mode: any
single fetch failure logs at warn, leaves that field null, and the batch
continues; a failed batch retries each tick inside the window.
**v1.90.0**: the morning digest carries a one-line ledger summary
(`vendorDigestLine`, pure): home (with signed home drift), solar, grid, battery
out / grid-charge, and the dark-core PV estimate when present. Null when the
record is missing or empty — the digest never carries a hollow line.
**v1.100.0**: the line had never rendered. The digest fires at
`NOTIFY_DIGEST_HOUR` (default 7, so 07:00 site time) while this job is gated to 06:35-09:00
site time, so `prevYmd(today)` is absent at digest time whenever the digest hour comes
before the job completes. That is every morning at a digest hour of 6 or earlier, or when the job runs late in its window. It now falls back to `latestVendorDay(state)` and NAMES the day:
"Yesterday per the EcoFlow ledger: …" only when the record genuinely is
yesterday, otherwise "Per the EcoFlow ledger (YYYY-MM-DD): …". Moving the job
earlier was rejected — the 06:35 window exists so ~19 sequential vendor requests
do not compete with the morning poll budget, and the vendor's daily record is
not reliably complete before then.

### 12b. Settings-drift watchdog (`settingsDrift.ts`, v1.83.0)

Read-only 60 s tick over the raw quota of the SHP2 + every DPU. Pure core:
`extractSettingsSurface` (flat-first with `pd303_mc.` fallback; DPU keys under
`hs_yj751_pd_app_set_info_addr.`), `diffSurfaces` (both-sides rule — a key
missing on either side is availability, never drift), `evaluateDrift`
(2-observation debounce; confirmed baseline advances and persists),
`classifyChange` (own-write = SHP2 `backupReserveSoc` moving to the actuator's
target/restore while a night is in flight — judged per leg of the charge cycle,
`legDriftActive`: the overnight leg by this rule, a mid-day leg only in its apply
window and its write — or to the owner's pending
`/api/reserve-floor` value — logged, not pushed; v1.165.0 adds the force-charge
keys `ch{n}ForceCharge` / `foceChargeHight` inside our force-charge window and its
15-min tails; everything else external). v1.187.10 — inside that window a
force-charge key is own-write only at a value this add-on COMMANDED
(`forceChargeCommandsOf`, nightForceCharge.ts: ON to the slots it switched on while
no OFF has been issued, OFF to those slots once it has, the ceiling at the synced
backstop or, once the restore is issued, the panel's own value). Any other movement
in the window is `panel-side` — logged at info as changed on the panel, not by the
add-on (the panel's own ceiling stop, or a manual Charge Now), and not pushed, as
before. On 2026-10-02 the panel's 87% ceiling stopped slots 2 and 1 at ~04:24–04:25,
~4 min before the add-on's OFF, and both were logged as the add-on's write. Known
limit: a manual Charge Now inside the window or its tails is still not pushed. External changes batch into ONE [Medium] push (dedupId
`settings_drift`) held through `NOTIFY_QUIET_HOURS`. First boot adopts
silently. Sidecar `/data/settings-surface.json` (atomic; corrupt = silent
re-adoption). Harness: `scripts/mutate-settings-drift.mjs` (5 mutants).

### 12c. Charge Now responder (`chargeNowResponder.ts`, v1.84.0)

Consumes the peak-grid-draw observation (verdict + slot-numbered force-charge
states) published by the alert monitor (`setLastPeakDrawObservation`) — never
re-derives the economics; a stale observation (>3 min) is no basis to act.
Modes via `CHARGE_NOW_RESPONSE` (fail-safe to `advisory`): advisory = one
[Medium] push per episode; supervised = announce + audited
`setChannelForceCharge` write (PD303_APP_SET, 5-min per-slot cooldown) +
readback (device must show OFF within 3 min; 1 retry; honest failure push);
off = inert. Rails: storm-prep hold (stand-down while any `storm-*` advisory
is active, logged once per episode); episode latch (releases when the verdict
clears or force charge reads OFF); daily cap 2 (past it: advise, never
write); OFF is the only writable value. Harness:
`scripts/mutate-charge-now.mjs` (5 mutants).

### 12d. HA statistics export (`haStatistics.ts`, v1.89.0)

Publishes the vendor ledger as EXTERNAL long-term statistics over the
supervisor's Core WebSocket (`recorder/import_statistics`): five `Wh` series
under source `ecoflow_panel` (`vendor_home_energy`, `vendor_solar_energy`,
`vendor_grid_energy`, `vendor_battery_in_energy`, `vendor_battery_out_energy`).
One hourly row per ledger day at 12:00 site time, floored to the UTC hour (19:00 UTC on the
reference plant, whose zone has no DST); `sum` cumulative in day order; null days skipped. Full idempotent
re-import after each morning job + `POST /api/energy-history/export-ha`.
Never writes `sensor.*` statistics — dashboard healing is by selecting the
ledger series. Failures log and retry the next morning; a missing
SUPERVISOR_TOKEN fails all series without throwing.

**B2 (same release):** `computeTotals` exposes `fleet.batteryChargeWh` /
`batteryDischargeWh` (gross pack-DC, SHP2-connected members); the daily job
stores them per day and `computeLocalPackRte` (≥ 2 kWh charge/day, ≥ 5 days)
reports the pack-DC round-trip ratio on `/api/energy-history` — declared
`basis: 'pack-dc'`, an upper bound on the AC dispatch RTE. `DISPATCH_RTE`
(0.86) is unchanged.

### 12e. Long-offline reconnect auto-audit (`reconnectAudit.ts`, v1.90.0)

Watches every non-spare DPU's cloud presence and, when one returns after
≥ 24 h continuously offline, runs a 30-minute transition audit automatically —
the checkpoints every manual review of a long outage has asked for: online
flip time, first-telemetry latency, `offline-<sn>` alert resolution latency
(measured against the alert monitor's real tracked set via
`monitor.activeAlertIds()`), a pack SoC/spread table captured ≥ 10 min after
the flip, and fleet `pvCoverage` at flip vs. at report (the dark-core
blind-spot restoration signal). Exactly one `[Medium]` push per reconnect.
The report states those checkpoints and nothing else; the PV-coverage change is
the outcome it reports (`renderReconnectReport`). Until v1.187.23 every report
also ended with a fixed solar-yield prediction written for one device of one
installation — a constant from a past outage, never computed, pushed whichever
device returned.

- Pure decision core (`evaluateReconnectWatch`) over injected `DeviceObs`
  snapshots; the index.ts driver ticks at 60 s and only feeds and dispatches.
- A presence **flap never audits**: arming requires the full 24 h of
  continuous offline; any earlier return silently clears the tenure clock.
- Offline tenure and the armed-log latch persist in
  `/data/reconnect-watch.json` (atomic write), so a deploy during a multi-day
  outage cannot reset the arming clock. An in-flight 30-min audit does NOT
  survive a restart by design (its checkpoint timestamps would be fiction).
- `pvCoverage` is fetched from analytics at most once per 5 min, and only
  while a tenure is armed or an audit is live — zero steady-state cost.
- Kind classification falls back to `productName` when a device has no
  projection (a device dark since boot has none — and is exactly the device
  this watch exists for). Spare DPUs are excluded (expected-offline is the
  zombie gate's domain).

### 12f. Warranty evidence export (`warrantyExport.ts`, v1.90.0)

`GET /api/warranty-export?sn=<SN>&format=md|csv|json` (with no `sn`: the built-in serial while that device is on the account, Core 3 of the
reference plant; else the one latched-defective chassis; else a 400 naming each serial's last
four characters;
default format = markdown) renders a paste-ready RMA evidence bundle from the
live projection plus the persisted `cleared-alerts.json` history: device error
code, EMS parallel-voltage window, a per-pack table (pack SN, SoC, SoH, pack
voltage, cell spread, cycles, remaining capacity, temperature), the full
per-cell voltage grid (markdown lists or one-row-per-cell CSV), and up to 200
alert-history rows for the serial (admitted by id-contains-SN **or**
`sourceSn` — the v1.78.0 SN-less-id lesson). Spread is computed from the real
cell grid when present (min/max), falling back to the projected
`maxVolDiffMv`. Read-only and, like the other reads, open: it carries no write gate.

**Discovery probe (same release):** `GET /api/debug/vendor-history-probe`
(`?month=YYYY-MM`, default last month) asks the historical-data endpoint
whether `-Month`/`-Year` variants of the five documented `-Week` chart codes
exist, at 400 ms spacing, and returns the raw per-code outcomes. Read-only,
on-demand only; results are recorded in the chapter-12 "Vendor API notes" once known.

### 12g. SQLite snapshot for external viewers (`dbExport.ts`, v1.107.0)

The recorder database lives at `/data/ecoflow.db`. `/data` is **private per
add-on** — no other add-on can open it, so a viewer such as sqlite-web has no
path to point at. This publishes a point-in-time copy to `/share`, which every
add-on can read; `share:rw` was added to the add-on `map:` in the same release.
The add-on writes only the snapshot there and, since v1.187.20, the backup hook's journal
(`/share/ecoflow-panel/backup-window.jsonl`).

`POST /api/db-export` (write-auth + rate-limited to 6/hour) produces the copy
and returns `{path, bytes, sourceBytes, elapsedMs, generatedAt}`. Optional
`?name=` overrides the filename. `GET /api/db-export` reports the currently
published snapshot — path, size, mtime, whether an export is in flight — without
producing a new one. Default output: `/share/ecoflow-panel/ecoflow-snapshot.db`
(`DB_EXPORT_DIR` overrides the directory).

Three design constraints, each load-bearing:

- **`VACUUM INTO`, not `cp`.** The live DB is WAL. Copying the main file drops
  everything still in `-wal` — the newest samples — and copying the file set
  non-atomically can tear it. `VACUUM INTO` yields a transactionally consistent,
  defragmented, WAL-free single file, which is also the shape a viewer wants.
- **Its own worker thread.** `DatabaseSync` is synchronous, so whichever thread
  vacuums has its event loop pinned for the copy. The main thread runs the alarm
  engine and the analytics worker backs every dashboard panel, so the export gets
  a third, short-lived thread that exits when done. It also opens its **own**
  handle: `readRecorder.ts` sets `query_only = ON`, and SQLite refuses
  `VACUUM INTO` on such a connection by statement *class* — reporting "attempt to
  write a readonly database" even though the source is never written.
- **Temp + rename.** `VACUUM INTO` refuses an existing target, so the copy is
  written to `.<name>.tmp` and renamed into place. The published path therefore
  always holds a complete, openable database; a failed or killed export leaves
  the previous good snapshot untouched. A stale temp is cleared unconditionally
  first, since a leftover one would otherwise wedge every future export.

The single caller-controlled path component is validated by
`sanitizeExportName` (`[A-Za-z0-9._-]+\.db`, no dotfiles, ≤100 chars); exports
are single-flighted so concurrent requests join one run rather than racing onto
the shared temp path. Harness: `scripts/mutate-db-export.mjs` (8 mutants).

### 12h. The owner reserve floor, and who is allowed to define it (v1.113.0–v1.116.0, v1.119.0)

`backupReserveSoc` has **three possible authors** — the owner, this add-on's
night-charge actuator, and EcoFlow Storm Guard (which raised it 20 → 40
unprompted during a 2026-08-30 thunderstorm warning). A consumer that reads the
device field is therefore asking "what is the reserve right now", when almost
every consumer means "what floor did the OWNER set". Four separate defects came
from that conflation; they are fixed by one shared fact.

**`ownerReserveFloorPct(actuationState, liveReservePct, nowMs)`** (`nightChargeActuator.ts`)
returns `priorReservePct` while our own write is holding the reserve up
(`isReserveArbitrageRaised` = applied && !reverted, persisted across restarts)
or — v1.187.10 — while the revert is still settling (`isRevertSettling`: the live
value still exactly our target, within `REVERT_READBACK_GRACE_MS` = 5 min of the
revert; the predicate the alert posture has used since v1.120.0), and the live
value otherwise. The revert stamps `revertedAtMs` on the cloud ACK, and the SHP2
reports our 50% for another ~20–60 s; the floor fell to that 50 until the readback,
and the runway (60 s cache) measured against it for ~90 s — 2026-10-03 00:01:25
"reserve in 5.6 h" from a 67 kWh pool with ~52 kWh above the real 16% floor, on 6 of
10 revert nights in 14 days. On grid the runway alarm is backstopped; a revert on a
grid loss (`decideActuation`'s grid-loss abort) would have run the full ladder
against 50, and a pool below 50 reads "at the reserve floor". Every call site passes
the clock: the boot seed, the per-snapshot push (which ends the hold on the
readback), `persistNightActuation`, the planner and the owner-floor route. Known
limit, shared with the posture: an owner or Storm Guard change to exactly the
night-charge target within 5 min of a revert reads as our echo until the grace
ends. Out-of-envelope or missing restore values fall back to the live reading
rather than inventing a floor.

Consumers, each of which had the bug independently:

- **`shp2-below-reserve` severity (v1.113.0).** Chose "genuine breach" vs
  "night-charge filling the pool" with `reserve <= 15` — a proxy valid only
  while the owner's floor sits below 15. At the 20 % floor set on 08-28 it
  INVERTS: a real breach classifies as arbitrage and stops pushing, so raising
  the floor for safety would have reduced coverage. Now keyed on posture.
- **The runway alarm (v1.115.0, actually fixed v1.119.0).** Read the device
  field and so manufactured "AT RESERVE FLOOR" for the whole charge window,
  nightly. v1.115.0's fix was INERT: it published through a module-level
  variable and read it in `analytics.ts`, which runs in the **analytics worker
  thread**, where main-thread module state does not exist. v1.119.0 pushes the
  floor across as a worker message (`{kind:'ownerFloor'}`), replayed on worker
  respawn and republished on every snapshot — not only on an actuation write,
  because Storm Guard moves the floor with no actuation event at all.
- **The night-charge planner (v1.116.0).** Plans recompute every ~30 min,
  INCLUDING mid-hold, so recomputes sized against floor+cushion = 50+15 = 65 %.
- **Settings-drift attribution (v1.115.0).** The owner's own write echoed back
  through the settings surface as an EXTERNAL change at warn level ~3 min later.
  `classifyChange` recognises a pending owner write before the night-active
  gate; the grace window is applied by the caller so the classifier stays
  clock-free.

**`POST /api/reserve-floor?pct=N` (v1.114.0)** lets the owner set the floor
through the add-on (write-auth, rate-limited, same audited helper and `[10,50]`
envelope as the actuator). It **refuses with 409 while a night-charge write is
in flight**: the actuator restores `priorReservePct` at window close, so a
change made underneath a live write would be silently reverted hours later. The
refusal names when that is (`reserveRestoreNote`, `restoreAtMs`): the window
close, or an hour before on-peak if that is sooner (`revertDueMs`); within a
minute on a cancelled night; or that the restore was due and has not completed.
`GET` is not provided — the device value is authoritative and already published.

**Drift disclosure (v1.119.0).** A `backupReserveSoc` change carries its own
dedupId (`settings_drift_reserve_floor`) and a title naming the consequence, so
a floor move can never be coalesced behind unrelated settings drift; the push
path logs its outcome, because it previously logged nothing on success OR on a
non-throwing failure and "was the operator told" was unanswerable from any
artifact. ★ An add-on write always appears in the write log — an EXTERNAL move
is provable by that log being empty for the transition.

Harness: `scripts/mutate-reserve-posture.mjs` (8 mutants) covers both silent
inversions — the magnitude proxy returning, and the arbitrage window paging
nightly — plus the runway regression and a corrupt-prior fallback.

### 12i–12o. Operations audits (moved)

Sections 12i–12o (announcement delivery, roster durability, detectors that could not fire, the spare-DPU list,
SHP2 self-heal, the announce path, reports that claimed more than they knew) are frozen, unedited, in
[operations-audits.md](../history/operations-audits.md).

### 12p. Notifications are Home-Assistant-native (v1.124.0)

Before this release the live channel was `ha`, whose entire transport was
`persistent_notification.create` — a card in the HA notification drawer. The companion
app shows those cards only when you open it: no OS push, no lock-screen alert, no
sound. There was no `mobile_app` reference anywhere in the repository. Combined with
in-house-only speakers and quiet hours, an owner who was away or asleep received
**nothing** for a critical battery, reserve-floor or grid event — and the add-on's own
config text implied the opposite.

The `ntfy` / Pushover / webhook channels existed to fill that gap and were never
configured. They are **removed** rather than fixed. Home Assistant already owns a
notification system with a first-party app, per-device targeting and a documented
Do-Not-Disturb bypass; running a second delivery stack beside it means two things to
configure, two things to keep alive, and a second set of credentials living in add-on
options.

The `ha` channel now does both halves of what HA offers:

1. **`persistent_notification`** — the durable drawer record, unchanged, still keyed by
   `dedupId` so a resolve dismisses the card it fired on.
2. **`notify.mobile_app_*`** — the actual push, to every service listed in
   **Notify Push Targets**.

**Critical alerts break Do Not Disturb.** A `critical` alert — and only a critical one —
carries the companion app's documented payload: `data.push.sound = {name: default,
critical: 1, volume: 1.0}` for iOS, and `data.ttl: 0` / `priority: high` /
`channel: alarm_stream` for Android. One payload serves both platforms, since each
ignores the other's keys. Warnings and advisories arrive as ordinary pushes that respect
the phone's settings. That asymmetry is deliberate: a warning that behaves like an
emergency teaches the owner to silence the channel carrying the emergencies. The bypass
is on by default and can be switched off.

Phone notifications reuse the drawer card's id as their `tag`, so a notification for the
same subject replaces its predecessor rather than stacking, and a resolve supersedes the
alert it closes.

**v1.187.10 — no device serials in a phone push.** The companion-app push travels through
Apple's or Google's push service, so a serial-shaped token (16 upper-case letters and digits, at
least two of each) in the push title or message is shown as its last six characters
(`maskDeviceSerials`, the pack-tail convention), and in the `tag` it becomes a short stable digest
(`maskSerialsInId`): a resolve still replaces its own alert, and two devices sharing a tail never
share a tag. The drawer card, the logs and the API keep full serials. A push already on a phone
from before the upgrade keeps its old tag, so its resolve after the upgrade arrives as a separate
notification.

**`reachesAPhone` is now a distinct question from `isConfigured`.** The old
`configured: true` was satisfied by a supervisor token alone, while delivering only a
drawer card — which is exactly how "alerts are configured" and "alerts reach nobody"
became indistinguishable. `/api/notify/status` reports both, plus the resolved target
list and any per-target push failures.

**v1.131.0 — the failure record is written before the throw.** `lastPushFailures`
used to be assigned *after* the all-targets-failed `throw`. In the live
single-target configuration that made the assignment unreachable on the only path
that can fail: with one target, 100% down is the sole way to fail. The field
therefore read `[]` both when the push channel was healthy and when it was
completely dead — beside `reachesAPhone: true` — and it is the only
machine-readable push-health signal the add-on exposes. The dispatch loop is now
`dispatchMobilePush(targets, payload, call)` with the service call injected: it
records, then throws if every target failed (the throw is deliberate — the
caller's dispatch marks the alert failed so the next evaluate tick retries it).
Mutation-proven load-bearing (`scripts/mutate-detector-honesty.mjs`, mutants
xvi–xvii).

Removing the five dead options was verified safe before shipping: posting the option set
without them and re-reading it returned all five, proving `info.options` is the effective
set with `config.yaml` defaults merged in — so they were defaults, never stored user
data, and dropping them from the schema leaves nothing stale behind.

### 12q. The outage cushion, re-scoped (v1.125.0)

`ARB_OUTAGE_CUSHION_PCT` was a flat 15 % of pool, and the test asked whether a
deliberately grid-blind forward simulation stayed above floor+cushion. That
simulation runs the **whole house** off the battery for the entire remaining
forecast horizon — 25 to 49 hours. On the reference plant that is P90 load of 156–185 kWh/day
against a 92.16 kWh pool, so the trough hit zero 1–8 hours after window close on 7 of
7 nights and `cushionShortfall` was pinned **true by arithmetic**.

Being a constant, it silently exempted every night from three separate mechanisms —
the under-buy pool, the buy de-bias learner, and the engine-fault strike detector — so
each reported "nothing to see" for a reason unrelated to whether there was anything to
see.

**Why it could never be met.** The model described a scenario the hardware does not
create. When the grid drops, the SHP2 carries its *backup circuits*; the rest of the
house is dead. Measured live on 2026-09-05: `panel_load_watts` **1445 W** against
`runway_recent_load_watts` **4863 W** — a 3.4× difference. Draining the pack at
whole-house load was modelling an island that cannot happen.

**The re-scope.** The cushion is now the energy to carry the islanded load through a
bounded outage:

```
cushionKwh = outageHours × islandedLoadKw × safetyFactor / dischargeEff
```

tested against the pack at window close. At 1.445 kW, 8 h and a 1.5× factor that is
~18.5 kWh — *larger* than the old flat 13.8 kWh band, so this is not a loosening in
magnitude. What changes is that it is a reachable, physically meaningful statement
("we can run the backup circuits for eight hours") instead of an unreachable one ("we
can run the whole house for two days"), so the flag becomes a signal again and the
three disarmed mechanisms re-arm.

Two knobs: `ARB_OUTAGE_CUSHION_HOURS` (default 4) and `ARB_ISLANDED_LOAD_SAFETY`
(default 1.25). The safety factor is **monotone the strict way** — raising it makes the
requirement harder and buys more. No PV is credited, deliberately: an outage can begin
at dusk.

**The load basis is the 7-day mean, not a spot reading.** Panel load swings roughly 3×
across a day — measured on the reference plant, 1,445 W at 00:50 MST and 3,971–4,038 W the same evening — so an
instantaneous sample would make the cushion, and therefore the nightly purchase, depend
on *when* the plan happened to run, and a quiet-hour sample would understate it
threefold. `selfCons.loadKwh` is already the SHP2 `panel_load` energy over seven days;
its mean is **4.47 kW** on the reference plant.

**The defaults were calibrated against what the plant can actually reach.** The panel's
charge limit, `chargeWattPower`, is 7.2 kW for each connected battery (the Delta Pro Ultra's AC
input ceiling; every source slot's `ratePower` reads the same), not for the pool. Measured on
the reference plant on 2026-09-16/18 and again on 2026-10-13/14, with three Cores connected the grid import pins at
~19.1 kW and the pack takes (19.1 − house) × ~0.93, up to ~17 kW (the hardware charge envelope
in [15-2, failure modes and known limitations](15-2-night-charge-writes.md#11-failure-modes--known-limitations)),
so a clean six-hour night can fill the pool from any evening SoC. The figure the defaults were
first checked against read that per-battery limit as the pool's (7.2 kW × 6 h = 43.2 kWh,
about 72 % from a 25 % evening SoC) and under-stated the envelope by more than half; the
reachable-band test keeps that 72 % as its upper bound, the stricter one. Four hours at 1.25×
needs ~42 % at window close: comfortably reachable on a clean night, missed when the EV
contends for the grid input — which is exactly the discrimination that makes the flag
informative again. Eight hours at 1.5× would have needed **78 %**, which is simply a different
permanently-true flag. A test pins the default inside the reachable band in both directions,
so a future change cannot quietly make it unreachable *or* trivially satisfiable.

Worth knowing plainly: the reference plant can carry its protected panel for roughly **four hours**
at a typical post-charge state, not a day. Raising `ARB_OUTAGE_CUSHION_HOURS` will make
the planner buy more, but it cannot exceed what the charger and the pack can hold.

**Fail-closed.** With no islanded-load measurement — an SHP2 that is not reporting —
both the legacy flat band and the legacy whole-house trough stand, preserving the old
behaviour rather than silently granting a weaker guarantee. The pair is never mixed.

The whole-house forward trough is still computed and still reported as
`minProjSocPct` / `baselineMinSocPct`: "what if the entire house ran off the pack" is a
true and useful thing to disclose, it is simply not what the cushion is sized against.

---

