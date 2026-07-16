# Security Policy

`ecoflow-panel` is a Home Assistant add-on that monitors an off-grid EcoFlow
solar/battery system and drives a **life-safety depletion alarm**. It runs on the
operator's own Home Assistant OS host (typically a Raspberry Pi) on a private LAN,
authenticated to the local Home Assistant Supervisor. It is not a multi-tenant or
internet-facing service. Even so, because it can read household telemetry, publish
Home Assistant entities, and (when explicitly enabled) issue write commands to the
battery hardware, its security posture matters.

## Supported versions

The add-on ships as a single rolling release from `main`; only the **latest
published version** receives fixes. Upgrade to the newest tag before reporting an
issue, and include the version (`GET /api/version` returns `{version, ref}`).

| Version | Supported |
|---------|-----------|
| Latest published (`main`) | ✅ |
| Any older tag | ❌ (upgrade first) |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately via **GitHub Security Advisories** — on the repository, go to the
**Security** tab → **Report a vulnerability** (GitHub Private Vulnerability
Reporting). Include:

- affected version (`ref` SHA if known) and component (server API, MQTT ingest,
  broadcast/TTS, config, telnet TUI, HACS card, …),
- a description and, ideally, a minimal reproduction,
- the impact you believe it has.

You'll get an acknowledgement, and a fix or mitigation will be shipped as a normal
versioned release (tests + adversarial review + deploy) with credit in the
changelog if you'd like it.

## Security posture (what the add-on already does)

- **AppArmor profile** (`ecoflow_panel/apparmor.txt`) confines the container's
  filesystem and capabilities.
- **Write commands to the battery hardware are OFF by default** (`write_actions_enabled`
  is `false`); the send-command debug path additionally requires a `WRITE_DEBUG_TOKEN`.
  Every write is recorded to an append-only audit log.
- **Write/administrative endpoints are auth-gated** (CSRF/CORS controls, the
  send-command lockdown, and audit-log read auth).
- **Secrets** (EcoFlow `ECOFLOW_ACCESS_KEY` / `ECOFLOW_SECRET_KEY`, weather/HA
  tokens) are supplied through the add-on options and are never logged; the panel
  reports credential **presence**, never values.
- The trusted-LAN data API (`:8787`) and telnet TUI (`:2323`) are intended for the
  local network only; do not expose them to the internet. Use Home Assistant's
  Ingress for authenticated remote access.

## Scope

In scope: the add-on server (`server/`), the web UI (`web/`), the HACS Lovelace
cards (`lovelace/`), the MQTT/EcoFlow ingest, the broadcast/TTS pipeline, the
telnet TUI, and the configuration/deploy surface. Out of scope: vulnerabilities in
Home Assistant itself, the EcoFlow cloud/IoT platform, third-party dependencies
(report those upstream; we track them via Dependabot), and issues that require
already-privileged access to the host.
