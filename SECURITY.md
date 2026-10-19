# Security Policy

Power (`ecoflow_panel`) is a Home Assistant add-on that monitors an off-grid EcoFlow
solar/battery system and drives a **life-safety depletion alarm**. It runs on the
operator's own Home Assistant OS host (typically a Raspberry Pi) on a private LAN,
authenticated to the local Home Assistant Supervisor. It is not a multi-tenant or
internet-facing service. Even so, because it can read household telemetry, publish
Home Assistant entities, and (when explicitly enabled) issue write commands to the
battery hardware, its security posture matters.

## Supported versions

The add-on ships as a single rolling release from `main`; only the **latest
published version** receives fixes. Upgrade to the newest tag before reporting an
issue, and include the version (`GET /api/version` returns `{version, builtAt, ref}`).

| Version | Supported |
|---------|-----------|
| Latest published (`main`) | ✅ |
| Any older tag | ❌ (upgrade first) |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via GitHub Private Vulnerability Reporting — open
[**tesseractAZ/power → Security → Report a vulnerability**](https://github.com/tesseractAZ/power/security/advisories/new).
Include:

- affected version (`ref` SHA if known) and component (server API, MQTT ingest,
  broadcast/TTS, config, SSH TUI, night-charge write path, …),
- a description and, ideally, a minimal reproduction,
- the impact you believe it has.

You'll get an acknowledgement, and a fix or mitigation will be shipped as a normal
versioned release (tests + adversarial review + deploy) with credit in the
changelog if you'd like it.

## Security posture

### Trust boundary and network exposure

The add-on trusts its own host, the other add-ons on the Home Assistant Supervisor
network, and the local network it is installed on. It is designed so that nothing
outside that boundary needs to reach it.

| Port | Serves | Access control |
|------|--------|----------------|
| `8787/tcp` | Web dashboard, REST API, WebSocket, the browser console (`/console`), audio files for the speakers. Also the Ingress port. | Reads are open. Writes need write authorization (below). |
| `2323/tcp` | SSH control-room TUI | **Off by default** (`SSH_ENABLED: false`; `TELNET_ENABLED` is a deprecated alias). Password login (`TUI_USERNAME` / `TUI_PASSWORD`); every login is refused until a password is set. |

- **Reads are unauthenticated by design.** Home Assistant media players, Music
  Assistant and the SIP intercom fetch the alarm chime and speech files from the
  add-on at alarm time; a credential check there would turn an alarm into silence.
  Telemetry, history and forecasts are therefore readable by anything that can
  reach port 8787.
- **Write authorization** accepts a request that meets any one of three conditions:
  it arrives through **HA Ingress** (the `X-Ingress-Path` header *and* a TCP peer on
  the Supervisor network, with proxy headers ignored); it carries an **`Origin`** in
  the add-on's same-origin list (plus any `TUI_TRUSTED_ORIGINS`); or it carries the
  **`X-Panel-Write-Token`**, a random token stored at `/data/panel-write-token.txt`
  with mode 0600 and compared in constant time (delete the file and restart to
  rotate it). The `Origin` condition stops a web page on another site from writing
  through a browser; it is not an identity check, and a program on the LAN can send
  any header. Port 8787 is a **trusted-LAN interface**. For remote access, use
  Home Assistant Ingress, which carries Home Assistant's own authentication.
- **The console is display-only.** The SSH TUI and the browser console at
  `/console` show the same screens and issue no commands. The browser console
  rejects cross-origin WebSocket upgrades, caps concurrent sessions at 16 and
  closes idle sessions after 5 minutes; the SSH server caps connections at 16 (4 per
  address), closes a connection that receives nothing for 5 minutes, and ends one
  that has not logged in within 2 minutes. With a password set, both transports
  require a login: 3 attempts per connection and at most 10 failures in 10 minutes
  across all sessions; without one, the SSH console refuses every login. Usernames
  and passwords are never logged. The SSH host key is generated on first start in
  `/data`, and its fingerprint is printed in the add-on log at every start, to
  compare with what `ssh` shows on the first connection.
- **CORS** lets the add-on's own origins, Home Assistant's, and private-network or
  loopback origins (`10.x`, `127.x`, `172.16–31.x`, `192.168.x`, single-label
  `<name>.local`; any port or none) read API responses; other origins get no
  `Access-Control-Allow-Origin`.
- **Every POST, PUT and DELETE route requires write authorization**, and so do the
  three administrative reads (the write log, the add-on list and speaker
  discovery). The only exceptions are the two loopback-only backup-hook routes
  described in the next bullet (v1.187.20). Since v1.187.16 the alert-outcome and
  vendor-history backfill routes, the last two without the gate, carry it, and
  `server/test/writeRoutesGated.test.ts` fails the build if a write route in any
  server module is registered with neither the write gate nor the loopback gate. The chime, broadcast-configuration, database-export,
  statistics-export, reserve-floor and defective-pack routes are also
  rate-limited.
- **The two backup-window hook routes are loopback-only** (v1.187.20).
  `POST /api/internal/backup-window/pre` and `/post` are what the Supervisor's
  `backup_pre` / `backup_post` hook calls from inside the container, with no
  token. They answer only a TCP peer on the container's own loopback
  (`127.0.0.1`, `::ffff:127.0.0.1`, `::1`), read from the raw socket, never from
  a header; the LAN port and Ingress get 403. They can only pause and resume the
  database's WAL checkpoints for a backup copy, and a 10-minute dead-man resumes
  them if `post` never arrives. The write-route test scans every server module,
  so a route registered outside `index.ts` with neither gate fails the build.

Do not forward ports 8787 or 2323 to the internet.

### Device writes are off by default, bounded, and audited

With the shipped defaults (`NIGHT_CHARGE_MODE: advisory`,
`CHARGE_NOW_RESPONSE: advisory`, `WRITE_DEBUG_TOKEN` empty) the add-on never changes
a device setting. The write paths, and what enables each:

| Write | Enabled by | Bounds |
|-------|-----------|--------|
| Night-charge **reserve raise** (`backupReserveSoc`) | `NIGHT_CHARGE_MODE: supervised` or `auto` (`auto` behaves as `supervised` until the readiness gate graduates) | One write per charge night, validated into the panel's [10, 50] % range before any network call. Armed only after an announcement channel confirms delivery; cancellable until the window opens; readback-verified on apply and on revert; restored at the window close, or at once on a cancel or a grid loss. |
| Night **force-charge** (per-channel force-charge and its ceiling, `foceChargeHight`) | The above, plus `ARB_OBJECTIVE: cost` and `ARB_COST_MAX_SOC_PCT` above 50 (set it to 50 to disable) | Starts only after the reserve raise has read back, and only for the last stretch of the window; ceiling validated into [80, 100]. Switching it off is unconditional (target reached, window end, cancel, revert, grid loss, a 7-hour backstop), readback-verified, re-issued while it still reads on, and escalated aloud. |
| **Charge Now responder** | `CHARGE_NOW_RESPONSE: supervised` | Only ever switches the app's force-charge **off**, during on-peak grid buying. |
| **Reserve floor** set by the owner | `POST /api/reserve-floor` with write authorization | [10, 50] %; refused while a night-charge write holds the reserve up. |
| Cloud-presence refresh | `POST /api/device/refresh-cloud/:sn` with write authorization | Re-sends the reserve value the panel already holds; 30 s per-device cooldown. |
| Raw command (debug) | `WRITE_DEBUG_TOKEN` set, plus write authorization, plus that token on the request | Command-set allow-list, parameter shape limits, 30 s per-device cooldown. |

Every device write goes through one audited helper and is appended to
`/data/writes.log` with its source, outcome and duration; the log is readable only
with write authorization. Writes carry per-device cooldowns. With two Smart Home
Panels on the account, writes go only to the recorded house panel, and new
night-charge writes wait while that panel is missing or unconfirmed (a restore is
never blocked).

### Container confinement

- **AppArmor** (`ecoflow_panel/apparmor.txt`, narrowed in v1.187.15 after
  complain-mode profiling of a running instance and of an isolated boot):
  - capabilities **`chown` and `dac_override` only**; `sys_admin`, `sys_module`,
    `sys_rawio`, `sys_ptrace`, `sys_boot`, `sys_time`, `mac_admin` and
    `mac_override` explicitly denied;
  - network limited to `inet`/`inet6` `stream` and `dgram` (TCP; UDP for DNS),
    `unix` (s6 IPC) and `netlink raw` (interface listing) — no raw or packet
    sockets;
  - **write-locked** (`deny … wl`): `/app`, `/usr`, `/bin`, `/sbin`, `/lib`,
    `/lib64`, `/init`, `/etc`, `/package`, `/command`, and
    `/var/{cache,lib,log,spool,opt,mail,local}`; reads of `/etc/shadow`,
    `/etc/gshadow`, `/root`, `/home` and `/etc/ssh` denied; writes to `/proc/sys`,
    `/sys` and `/proc/sysrq-trigger` denied; mount, umount, pivot_root, remount and
    ptrace denied;
  - the blanket `file,` read rule is **kept on purpose** (a per-path list once
    denied s6 re-reading `/init` and crash-looped the add-on), and no write mask
    combines `a` with `w` (the HAOS parser rejects it and the profile then fails
    to load).

  These invariants are pinned by `server/test/apparmorProfile.test.ts`, which runs
  in CI, and by the mutation harness `scripts/mutate-v1187-15.mjs`, whose anchors
  the CI anchor check resolves. The procedure and its evidence are in
  [`docs/reference/12-configuration-deployment-security.md`, “AppArmor profile”](docs/reference/12-configuration-deployment-security.md#apparmor-profile-ecoflow_panelapparmortxt).
- **Least-privilege Home Assistant access.** `hassio_role: homeassistant` (not
  `manager`): the only Supervisor call is a read-only add-on listing.
  `homeassistant_api` is used for notifications and announcements, entity state,
  the statistics export and, on request, setting up the Piper (Wyoming)
  integration.
- Storage: `/data` (private to the add-on) and `/share`, which is written only for
  the optional database snapshot.

### Secrets and personal data

- EcoFlow keys, the MQTT broker password, the TUI password and the debug token
  are add-on options of type `password`. They are never logged or echoed; the
  panel reports only whether a credential is present. The heartbeat URL is treated
  as a credential and is never logged.
- Phone pushes shorten device serial numbers to their last six characters.
- CI runs `scripts/check-no-secrets.py` on every push and pull request. It fails
  on private LAN addresses outside the example subnets, email addresses outside
  the documentation and placeholder domains, phone numbers outside the fictional
  555-01xx range, VoIP credential shapes and any token shaped like an EcoFlow
  serial number that is not a placeholder. Every rule is shape-based and lists
  no real value; three runtime files that still hold a serial are pinned to an
  exact count, so a new serial — or a fix that forgets its exemption — fails the
  build.
- A maintainer-side pre-push check compares outgoing commits against the real
  serial numbers and personal values, which are kept outside the repository so
  that the detector does not publish what it guards.

### Supply chain

- **GitHub Actions are pinned to full commit SHAs**, each with its version in a
  comment — every `uses:` line in every workflow (the last three floating tags
  were pinned in v1.187.16).
- **The runtime base image is digest-pinned** (`ghcr.io/home-assistant/{arch}-base`)
  identically in `build.yaml`, `.github/workflows/ci.yml` and
  `.github/workflows/images.yml`; a base update is a deliberate edit to all three.
- **Dependabot** (`.github/dependabot.yml`) proposes weekly updates for the
  server and web npm trees, GitHub Actions, and the Dockerfile's build stages,
  grouped production/development. Major versions are not proposed; they are
  migrated by hand.
- **Dependency-advisory gate.** `scripts/check-npm-audit.mjs` runs on every push
  and pull request. It fails on a **high or critical advisory in the production
  dependency tree** of `server/` or `web/` and reports everything else. A waiver
  in `scripts/npm-audit-allowlist.json` needs a reason and an expiry date, an
  expired waiver fails the build, and a waiver whose advisory is gone is reported
  as stale. The gate fails closed when `npm audit` cannot run, and it tests its
  own policy before auditing. The allowlist is empty at v1.187.16.
- **CodeQL** (`.github/workflows/codeql.yml`) analyses the workflows, the
  JavaScript/TypeScript and the Python scripts with the `security-extended`
  queries on every push and pull request and weekly. Results go to the Security
  tab, and `.github/scripts/check-sarif.mjs` fails the build on any error-level
  result or any rule with security severity 7.0 or higher. Accepted findings are
  listed in `.github/codeql-baseline.json` by rule **and** exact path, so the same
  rule in another file still fails.
- CI runs on every push and pull request: the three type-checks, the test suite
  (and the README-claim check), the mutation-anchor check, the secrets scan, the
  advisory gate, the add-on config validator, the release-PR version check (pull
  requests, `release-pr.yml`), the Docker smoke build, the documentation build and
  CodeQL. `main` is
  branch-protected, and every one of those checks is a required status check
  (fifteen in all, since 2026-10-11).

### Release integrity

- A release is a pull request titled `Release vX.Y.Z`. `release-pr.yml`
  (`scripts/check-release-pr.py`) compares `config.yaml`'s version before and
  after GitHub's test merge and fails a version change under another title, a
  `Release vX` title (or one-commit subject) that changes no version or names
  another one, a downgrade, a reused tag or a
  version below the highest tag, a version that is not `X.Y.Z`, and a missing
  CHANGELOG section. Home Assistant offers any version that differs from the
  installed one, a lower one included.
- `tag-release.yml` runs on every push to `main` (no paths filter, no subject
  gate). When the declared version is new and above every `vX.Y.Z` tag it creates
  the tag and dispatches `images.yml`, which runs the test suite and type-check at
  the tag, builds each architecture on a native runner from the digest-pinned
  base, and pushes `ghcr.io/tesseractaz/{arch}-ecoflow-panel` as `:X.Y.Z` and
  `:latest`. A reused number and a version it cannot tag are red runs, and while
  `main` declares an older release than the newest one (a revert) every push is
  red. Home Assistant installs the version named in `config.yaml`.
- Every job runs on a pinned runner image (`ubuntu-26.04`, `ubuntu-26.04-arm`;
  CodeQL on `ubuntu-24.04` until CodeQL lists 26.04 as supported), never
  `ubuntu-latest`, so the image changes only in a reviewed commit.
- The image-build Buildx setup step gets one retry after a pause, so a transient registry
  failure does not leave a version without a release. The GitHub Release takes its
  notes from the CHANGELOG and fails if the section is missing; it attaches the
  documentation only when that build succeeded and left a non-empty file, because
  Releases are immutable once created; and only the **highest** version (strict
  `vX.Y.Z` tags, compared as numbers) is marked Latest, so re-running an older
  release cannot demote a newer one.
- Images are not signed and carry no provenance attestation; the integrity anchor
  is the version tag built by this repository's workflow.

## Scope

In scope: the add-on server (`server/`), the web UI (`web/`), the MQTT/EcoFlow
ingest, the broadcast/TTS pipeline, the SSH TUI and browser console, the
night-charge write path, the AppArmor profile, and the configuration, build and
release surface. Out of scope: vulnerabilities in Home Assistant itself, the
EcoFlow cloud/IoT platform, third-party dependencies (report those upstream; they
are tracked here through Dependabot and the advisory gate), and issues that
require already-privileged access to the host or to another add-on on it.
