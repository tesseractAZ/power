## 9. The Online Learning Loop (shadow models, online regression, model health)

### What this is, and why it exists

The ecoflow-panel pack-risk model does not sit frozen. Every time the operator
tells the panel whether an alert was *real* or *noise*, that verdict is turned
into a labeled training example and fed back into a **shadow copy** of the
pack-risk logistic-regression (LR) model via a single stochastic-gradient-descent
(SGD) step. Over days and weeks the shadow model drifts away from the shipped
"champion" baseline in the direction that would have predicted the operator's
verdicts better. A separate model-health report (`/api/models/health`) tracks how
far the shadow has moved, whether that movement is real or a no-op, and whether
the currently-served model has degraded enough to be auto-benched.

This is the codebase's one genuine closed-loop learning system. The module header
of `server/src/models/onlineLR.ts` is blunt about the intent: it is the thing that
turns "ML cargo cult" into "ML that's actually learning." The rest of the fleet's
models (forecast, degradation, novelty, Bayesian/Kalman baselines) update
implicitly through their own statistical mechanisms or are pure heuristics —
pack-risk LR is the only differentiable, labeled-data-trainable model here.

The loop has four stages, each in its own file:

| Stage | File | Role |
|-------|------|------|
| 1. Capture inputs | `server/src/featureSnapshot.ts` | Freeze the feature vector **at alert-fire time** |
| 2. Capture label | `server/src/alertOutcomes.ts` | Record the operator's ack/dismiss/failed/resolved verdict |
| 3. Learn | `server/src/models/onlineLR.ts` | One SGD step on the shadow model per labelable outcome |
| 4. Report / gate | `server/src/models/modelHealth.ts` + `server/src/ml.ts` | Expose drift, precision, sample counts; decide whether to bench the model |

#### Honest framing: live vs scaffolding

- **Live:** feature-snapshot capture on every alert rise, outcome persistence,
  the online SGD step (with bias clamp and degenerate-feature guard), the
  prequential-loss EMA, the shadow-vs-baseline drift report, and the
  auto-downgrade **gate** that pins the model to the heuristic when it looks bad.
- **Scaffolding / not-yet-wired:** there is **no automatic promotion** of a
  shadow model to champion. The shadow file is *preferred* by inference the
  moment it exists, but "promotion" in the sense of blessing the shadow as the
  new frozen baseline happens only when a human re-runs the batch trainer
  (`scripts/train-pack-risk.ts`), which overwrites the baseline file via
  `saveModel`. Nothing in the request path calls `saveModel`. Likewise, "bulk
  retraining from accumulated outcomes" is referenced in comments but the online
  step is the only thing that consumes outcomes at runtime.

---

### The six-feature model being learned

Both the champion and the shadow are the same shape: a 6-weight + bias logistic
regression over `FEATURE_NAMES` (`server/src/ml.ts:56`):

| Feature | Meaning | Normalization (`normalizeFeature`, ml.ts:84) |
|---------|---------|-----------|
| `peerFadeRatio` | wear rate vs fleet (1.0 = average) | `clamp01((raw − 1) / 1.0)` → 2.0 = max risk |
| `rTrend` | internal-resistance rise, mΩ/month | `clamp01(raw / 3)` → 3 mΩ/mo = max |
| `coulombicEffPct` | discharge÷charge mAh | `clamp01((99 − raw) / 2)` → 97% = max |
| `hardLifeScore` | thermal-stress events/yr | `clamp01(raw / 300)` → 300 events/yr = max |
| `ccDriftMv` | charge-curve drift at SoC checkpoints | `clamp01(abs(raw) / 50)` → 50 mV = max |
| `fadePctPerYear` | SoH erosion rate | `clamp01((raw − 1) / 5)` → 6 %/yr = max |

Every feature is normalized to `[0,1]` where 1 = high risk; a null/non-finite raw
value maps to the neutral `0`. The in-code champion (`DEFAULT_MODEL`, ml.ts:250)
is heuristic-distilled:

```
weights = { peerFadeRatio: 1.5, rTrend: 0.9, coulombicEffPct: 0.9,
            hardLifeScore: 0.9, ccDriftMv: 0.6, fadePctPerYear: 1.2 }
bias    = -2.5
```

Inference is `p = sigmoid(bias + Σ wᵢ·xᵢ)`.

#### Two files on disk

```
<dbPath>/../models/pack-risk-lr-v1.json          ← MODEL_PATH  (champion / baseline)
<dbPath>/../models/pack-risk-lr-v1-online.json   ← SHADOW_PATH (online-updated)
```

The baseline is **frozen** — only the batch trainer overwrites it. The shadow is
rewritten after **every** SGD step. Inference (`loadModel`, ml.ts:307) prefers the
shadow when it exists, then the baseline, then the in-code `DEFAULT_MODEL`.

---

### Stage 1 — Feature snapshot at fire time (`featureSnapshot.ts`)

#### Why snapshot at all

When an alert fires, the operator may not act on it for minutes or hours. By the
time they ack/dismiss it, live telemetry has moved on. To train on *what the model
actually saw*, the feature vector is frozen **at fire time**, keyed by `alertId`.

#### What is captured

`captureSnapshot` (featureSnapshot.ts:155) writes a `SnapshotRecord` carrying two
distinct payloads:

1. **`features`** — a category-specific generic vector (diagnostics + pre-v0.9.59
   fallback). Extractors per category (`extractFeatures`, ts:210):
   - **Thermal** → `pack_temp_c`, `min/max_cell_temp_c`, `board_temp_c`, `pack_soc`, `mppt_hv/lv_temp_c`
   - **Battery** → `device_soc`, `p_in_w`, `p_out_w`, `bat_v_mv`, `bat_a_ma`, `pack_soc`, `pack_soh`, `pack_cycles`, `pack_vol_diff_mv`
   - **SHP2** → `pool_soc`, `reserve_soc`, `panel_load_w`
   - **Solar** → `pv_total_w`, `pv_hv/lv_w`, `pv_hv/lv_v`, `pv_hv/lv_a`
   - **Grid/Connectivity** → `device_online`, `snapshot_age_ms`
2. **`lrFeatures`** — the **real normalized 6-dim LR vector** (v0.9.59), produced
   by `captureLrFeatures` (ts:326) which calls the *same* `extractFeatures` /
   `normalize` path (`ml.ts`) that `computePackRiskV2` uses for inference. This is
   the training-inference-parity fix: the model trains on exactly the inputs it
   predicted from, not a proxy reconstructed later. It is populated **only for
   pack-level alerts** (`alert.packNum != null` and the device resolves to a DPU);
   for SHP2/EVSE/system alerts it is `null`.

`captureLrFeatures` pulls the four analytics reports (`degradation`,
`thermalEvents`, `internalResistance`, `chargeCurve`) from the analytics worker
(each internally TTL-cached ~60 s), runs `extractMlFeatures`, and returns
`fv.normalized`. Any error → `null` (SGD step is simply skipped). v1.186.0: it runs
detached, after the tick's dispatches, so its four worker reports never delay a push or an
announcement (before, the rising-edge loop awaited it).

#### Storage, dedup, and the once-per-rise fix

- In-memory **LRU** `Map` keyed by `alertId`, `MAX_IN_MEMORY = 500`, delete-before-set
  so Map insertion order = recency.
- Persisted append-only to `/data/feature-snapshots.jsonl`; on boot the most
  recent entries are re-hydrated (delete-before-set again so recency = *last*
  appearance, not first).
- **F20 fix (v1.19.0):** the caller (`alertMonitor`'s rising-edge pass, through `captureFeaturesDetached`) captures
  once per **rise** (transition from not-firing to firing). The old dedup
  (`if (cache.has(id)) return`) against a boot-hydrated cache meant a recurring
  alertId was *never* re-snapshotted — the "fire-time" vector could be weeks
  stale (outcome records once embedded features up to 618 h older than the fire
  they labeled). Now each rise captures fresh features. A `SAME_RISE_GUARD_MS =
  60_000` window absorbs same-rise double-invocation (boot replay racing a live
  tick), using `Math.abs(record.ts − prev.ts)` so an NTP backward clock step
  can't be misread as "same rise."
- **Compaction:** at boot, if the jsonl exceeds `COMPACT_BYTES = 512 KiB`, it is
  atomically rewritten (temp+rename) from the retained cache — the host can lose
  power mid-write (the reference plant's did daily), so an in-place truncate could destroy the only copy.

---

### Stage 2 — Outcome capture (`alertOutcomes.ts`)

#### The label space

The operator's response is the ground-truth label (`AlertOutcome`):

| Verdict | Meaning | Learning use |
|---------|---------|--------------|
| `ack` | "real, I'm handling it" | true positive → label **1.0** |
| `dismiss` | "noise, stop nagging" | false positive → label **0.0** |
| `failed` | "this preceded an actual failure" | strong TP → label **1.0**, sample weight **2×** |
| `resolved` | "system cleared it itself" | ambiguous → **skipped** (no label) |

#### The record and its endpoint

`POST /api/alerts/outcome` (index.ts; write-auth since v1.187.16) validates the verdict against
`['ack','dismiss','failed','resolved']`, then assembles an `AlertOutcomeEntry`
(alertOutcomes.ts:33) by joining the request to the frozen snapshot:

```
ts, alertId, category, severity, outcome, notes,
features:     snap?.features,      // generic vector
lrFeatures:   snap?.lrFeatures,    // real LR vector (pack alerts only)
alertFiredAt: snap?.ts,            // for time-to-action
source: { ip, ua }
```

`appendAlertOutcome` (ts:131) sanitizes before writing one JSON line to
`/data/alert-outcomes.jsonl` (append-only, kept forever — the labeled dataset
grows in value). Sanitization (`sanitizeOutcomeEntry`, ts:100) re-serializes an
explicit typed shape: verdict allow-listed to a fresh literal, numbers coerced
finite, feature maps bounded to 64 keys with cleaned keys, strings length-bounded
— defending the on-disk file against the operator-supplied `notes` and any
request-derived field (CodeQL `js/http-to-file-access`). The `lrFeatures` tri-state
is preserved: `undefined` = pre-v0.9.59 row (key omitted), `null` = "no LR vector"
(non-pack alert), object = real vector.

#### Family rollups and precision

`computeFamilyStats` (ts:282) groups outcomes by **family** — `familyOf` (ts:241)
strips the device serial by splitting `alertId` on `-` and stopping at the first
token containing an uppercase letter (families are all-lowercase like `pack-hot`,
`cell-imbalance`; serials are uppercase), then drops a trailing all-digits pack
number so `pack-hot-3` and `pack-hot-7` roll up under `pack-hot`. Per family:

```
precision = (ack + failed) / (ack + failed + dismiss)      // null unless ≥1 dismiss and ≥3 decided (familyPrecision, v1.123.0)
medianTimeToActionMs = median(ts − alertFiredAt)           // null for persistent families
```

`PERSISTENT_FAMILIES = { 'offline', 'grid-offgrid' }` return `null` for
time-to-action: their condition is continuously true, so `ts − alertFiredAt` is
condition-age not response latency (a 7-day audit of the reference plant saw 9.44 d for `offline`,
13.18 d for `grid-offgrid` — meaningless as response time). Families are sorted
noisiest-first (lowest precision, then highest volume).

---

### Stage 3 — The online SGD step (`onlineLR.ts` → `updateFromOutcome`)

Fired synchronously from the `POST /api/alerts/outcome` handler in index.ts, after the entry is
appended, on every submission.

#### Constants

```
LEARNING_RATE       = 0.05    // conservative — a few outcomes/day
L2                  = 0.001   // ridge on weights (not bias)
FAILED_LABEL_WEIGHT = 2.0     // 'failed' pulls 2× harder
BIAS_CLAMP          = 1.0     // bias bounded to ±1.0 of baseline bias
DEFAULT_BASELINE_BIAS = -2.5  // used only if no on-disk baseline exists
```

#### Step 0 — build the feature vector (`snapshotToLrFeatures`, ts:96)

Prefer the captured `outcome.lrFeatures` verbatim (real inference inputs). Each of
the six names is copied if finite, else set to `0`; if **at least one** value is
present, that vector is used. Only pre-v0.9.59 historical rows (no captured
vector) fall to the **proxy** reconstruction from generic `features` — explicitly
documented as known-bad (`rTrend` proxied off pack temperature would train "every
pack in a hot summer = high risk"; `coulombicEffPct` had no source and defaulted to
0). Returns `null` when no usable vector can be built.

#### Step 1 — guards (honest-null / no-op prevention)

1. **`resolved` → skip** (ambiguous, `updated:false`, `reason:'resolved (ambiguous)'`).
2. **No features** → skip (`reason:'no features captured'`).
3. **Degenerate-feature guard (v0.13.0, ts:249):** iterate the six features; any
   NaN/Inf → skip (`reason:'degenerate-features'`); **all-zero → skip** (same
   reason). This is the P0-2 fix: a non-pack outcome collapses to an all-zero
   proxy vector, and with `x = 0` the gradient's data term vanishes so *only the
   bias moves* — 13 system-level labels once walked the pack-risk baseline from
   2.5% to 12.9% with every `weightDelta` exactly 0. Now such outcomes are still
   *persisted* for audit but do **not** train.

#### Step 2 — the math

Binary cross-entropy logistic SGD, one sample:

```
label       = (outcome === 'dismiss') ? 0 : 1          // ack + failed → 1
sampleWeight= (outcome === 'failed')  ? 2.0 : 1.0

logit = bias + Σ wᵢ·xᵢ
p     = sigmoid(logit)
error = (p − label) · sampleWeight

# per-weight (ridge-regularized):
grad_i = error·xᵢ + L2·wᵢ
wᵢ    ← wᵢ − LEARNING_RATE · grad_i

# bias (NO regularization):
rawBias = bias − LEARNING_RATE · error
newBias = clamp(rawBias, baselineBias − 1.0, baselineBias + 1.0)
```

`sigmoid` is the numerically-stable two-branch form (ts:151). `baselineBias` comes
from `loadBaselineBias` (ts:190) which reads the **on-disk baseline** (`MODEL_PATH`),
not the shadow — the clamp anchor must be the frozen model, not accumulated drift.

**Why the bias clamp (v0.13.2):** even a legitimate one-sided stream (every alert
ack'd, never dismissed) drives `bias −= η·(p−1)` monotonically upward forever.
Bounding to ±1.0 of baseline keeps the intercept from walking unboundedly while
still allowing real adaptation (a logit shift of 1.0 already moves a 50% prediction
to ~73%). Weights and the inference path are untouched — only the bias is bounded.

#### Step 3 — prequential loss tracking (v0.15.12)

`finalLoss` was once a hardcoded `0` inherited from the shadow-init template,
publishing as a misleadingly perfect training loss. It now tracks a real
prequential (test-then-train) log-loss: each sample's cross-entropy is computed
against the **pre-update** model and smoothed with an EMA (`LOSS_EMA = 0.9`, ~10-sample
horizon), seeded from the first online step:

```
pClamped   = clamp(p, 1e-7, 1 − 1e-7)
sampleLoss = −(label·log(pClamped) + (1−label)·log(1−pClamped))
newFinalLoss = finalLoss>0 ? 0.9·finalLoss + 0.1·sampleLoss : sampleLoss   // rounded to 4 dp
```

#### Step 4 — persist the shadow

Write the updated `LrModel` to `SHADOW_PATH` (`saveShadow`, ts:207), stamping
`trainedAt = now`, `samples += 1`, `source = 'labeled'`, and a provenance `notes`
string. The `alertId` embedded in `notes` is request-derived, so it is
allow-listed (`[^A-Za-z0-9._:-] → _`) and length-bounded to 120 chars before it
lands on disk. The baseline file is **never** touched.

Return shape:
```ts
{ updated: boolean, prevLogit: number, newLogit: number, label: number | null, reason?: string }
```
The endpoint surfaces only `onlineLrUpdated: result?.updated ?? false` to the client.

#### `loadCurrent` / `loadShadowModel`

`loadCurrent` (ts:157) reads the shadow file first, then the baseline, then falls
to an in-code seed (`version:'lr-online-shadow-init'`, same weights as
`DEFAULT_MODEL`, bias −2.5). `loadShadowModel` (ts:337) is the read-only export the
health report uses to show "online has diverged from baseline by N%."

---

### Stage 4 — Model health & the gate

Two consumers read the loop's state: the **health report** (`/api/models/health`,
diagnostic) and the **auto-downgrade gate** (`computeGateDecision`, authoritative —
it decides whether the served model is trusted). Since v1.18.0 (F16) the report
single-sources the gate verdict so the two can never disagree.

#### The gate — `computeGateDecision(model)` (ml.ts:726)

Three independent degrade conditions; any one benches the model.

**Knobs** (environment-only: no add-on option sets them, so a Home Assistant install runs the
defaults; parsed by `gateEnvNum`, which rejects empty/NaN/negative so `Number('') === 0` can't
silently zero a threshold):

| Env var | Default | Meaning |
|---------|---------|---------|
| `PACK_RISK_DRIFT_THRESHOLD` | `2.0` | max allowed shadow-vs-baseline L2 |
| `PACK_RISK_MIN_PRECISION` | `0.4` | min alert-family precision |
| `PACK_RISK_MIN_TRAINING_SAMPLES` | `100` | min samples before a labeled shadow may serve |
| `PACK_RISK_MIN_DECIDED_OUTCOMES` | `3` | min decided outcomes (with ≥1 dismissal) before precision is evidence |

**Condition A — samples (F16, dominant).** An immature online shadow must not
reach the operator composite:
```
samplesBad = provenance !== 'baseline'
          && source     !== 'heuristic-distilled'
          && !(Number.isFinite(model.samples) && model.samples >= 100)
```
Exemptions are deliberate: a `heuristic-distilled` model (in-code default /
distilled fit) mirrors the heuristic by construction, and a `baseline`-provenance
labels.csv batch fit is converged and legitimately has ~one sample per fleet pack
(~20–25). Everything else — the online-SGD shadow, or any file with missing/
unrecognized `source` (fail-safe: `undefined === 'labeled'` is false, and
`undefined < 100` is false, so a corrupt file can't sneak through) — must show a
finite `samples ≥ 100`. This gate catches the reference plant's incident where a 13-sample
one-class shadow (99.99% bias, "raise everyone's risk") inflated healthy-fleet
composites 4–7×.

**Condition B — drift.** L2 distance shadow-vs-baseline, read via
`loadBaselineModelOnly()` (the true frozen baseline, bypassing loadModel's shadow
preference):
```
driftL2 = sqrt( Σ (shadowᵢ − baselineᵢ)² + (shadowBias − baselineBias)² )
driftBad = driftL2 != null && driftL2 > 2.0
```
If no on-disk baseline exists, `driftL2 = null` (**unknown, not 0**) — the pre-F16
`driftL2 = 0` displayed as a measured "no drift" while the shadow's real
divergence was structurally invisible. `null` does not degrade by itself; the
samples gate covers the cold-start case.

**Condition C — precision.** Evidence only when the stream can express a false
positive:
```
overallPrecision = (totalDismiss > 0 && totalDecided >= 3)
                   ? totalReal / totalDecided : null
precBad = overallPrecision != null && overallPrecision < 0.4
```
A one-class all-`ack` stream pins precision at 1.0 forever, which is not a
measurement — the reference plant's 33 batch-acks (median time-to-action 21.9 **days**)
rendered a fake permanent 1.0. Requiring ≥1 dismissal fixes that; since every
sub-0.4 stream necessarily contains dismissals, this guard can delay a genuine
degrade by at most two outcomes, never block it.

**Verdict:**
```
degraded = samplesBad || driftBad || precBad
reason   = samplesBad ? 'samples'                       // dominates
         : driftBad && precBad ? 'drift+precision'
         : driftBad ? 'drift' : precBad ? 'precision' : undefined
```

#### How the gate is applied (`computePackRiskV2`, ml.ts:852)

The pack-risk composite is `mean(heuristic, trained, novelty)`. When the gate
fires:
- The **trained** track is pinned to the heuristic score (`trainedScore =
  gate.degraded ? heur.score0to100 : pred.score0to100`) so a crashed shadow can't
  crater the composite. The raw `pred.probability`/`contributions` stay exposed
  for debug.
- If `reason === 'samples'` (immature ML stack) the composite drops the novelty
  track too — it becomes **heuristic-only** (`composite = heur.score0to100`),
  because an unsupervised novelty score built from a 16-sample charge-curve
  checkpoint was itself part of the 4–7× inflation. Mature-model degrades
  (drift/precision) keep the pre-existing behavior: trained pinned, novelty still
  averaged.

#### The report — `computeModelHealth()` → `GET /api/models/health`

Endpoint: `app.get('/api/models/health', cached(..., computeModelHealth(), 60))`
in index.ts — 60 s cache.

`computeModelHealth` (modelHealth.ts:69) resolves a **true** baseline via
`loadBaselineModelOnly()` (falling back to in-code `DEFAULT_MODEL` when absent —
critically *not* the shadow, or every delta would read 0), diffs it against
`loadShadowModel()`, and single-sources the gate verdict from
`computeGateDecision(loadModel())`.

`ModelHealthReport` (modelHealth.ts:21) shape:

| Field | Source / meaning |
|-------|------------------|
| `generatedAt` | `Date.now()` |
| `packRiskLr.baseline` | `{version, trainedAt, samples, source}` of the frozen baseline |
| `packRiskLr.shadow` | same fields for the online shadow |
| `packRiskLr.weightDeltas` | per-feature `shadow − baseline`, plus `_bias` |
| `packRiskLr.totalDriftL2` | `sqrt(Σ delta²)` incl. bias |
| `packRiskLr.driftBasis` | `'baseline'` if a trained file exists, else `'default-seed'` (movement is vs the in-code seed, **not** true drift) |
| `packRiskLr.baselineOnDisk` | whether `MODEL_PATH` exists |
| `packRiskLr.onlineSamples` | `max(0, shadow.samples − baseline.samples)` |
| `packRiskLr.effectiveOnlineSamples` | same, **but 0 unless some weight/bias actually moved** (>`DELTA_EPSILON = 1e-9`) — makes a P0-2 no-op ("13 updates, 0 drift") visible instead of silently claiming progress |
| `alertFamilies` | `computeFamilyStats()` (per-family precision, TTA, counts) |
| `labeledAlertCount` | total outcomes with verdicts |
| `overallPrecision` | the gate's evidence-guarded precision (`null` unless ≥1 dismissal and ≥3 decided) |
| `gate` | the full `computeGateDecision` object — the authoritative served-model verdict |

`driftBasis` matters: with no on-disk baseline, `totalDriftL2` measures movement
from the in-code seed, while the gate's `driftL2` reads `null`. The two numbers
answer different questions and the report labels which is which so the +0.586
all-bias walk can no longer render as authoritative drift.

---

### Promotion: what actually happens (and doesn't)

There is **no runtime promotion path.** Concretely:

- `updateFromOutcome` writes **only** `SHADOW_PATH`. It never calls `saveModel`.
- `saveModel` (ml.ts:364, overwrites `MODEL_PATH`) is called **only** by the
  offline batch trainer `scripts/train-pack-risk.ts` — a human-run tool.
- Inference (`loadModel`) *prefers* the shadow the instant it exists, so in
  practice the online shadow **is** the served model without any explicit
  blessing — but that model is exactly what the samples/drift/precision gate
  polices, and until it clears the `PACK_RISK_MIN_TRAINING_SAMPLES = 100` floor
  its score is pinned to the heuristic and contributes nothing to the composite.
- To "promote" the shadow to a new frozen champion, the operator re-runs training
  (which rebuilds the baseline from labels/heuristic distillation). There is no
  automated "shadow beat champion on held-out data, swap it in" step — that
  comparison would be the natural next stage, but it is not implemented.

So the honest summary of the loop's autonomy: **it learns continuously and serves
its learning immediately, but it is fenced by a conservative gate rather than
promoted by a champion-challenger evaluation.** The gate — not a promotion
decision — is what protects the life-safety alarm from a mis-trained shadow.

---

### Edge cases & guard summary

- **`resolved` outcomes** never train (ambiguous) but are still persisted.
- **Non-pack alerts** (SHP2/EVSE/system) capture `lrFeatures = null`; their
  outcomes persist for audit but the all-zero proxy is refused by the
  degenerate-feature guard, so they cannot walk the pack-risk bias.
- **NaN/Inf features** → step refused (`reason:'degenerate-features'`).
- **One-sided label streams** — bias clamp (±1.0 of baseline) bounds intercept
  walk; precision gate ignored until a dismissal exists.
- **No on-disk baseline** — drift is `null` (unknown), not a false 0; report
  labels `driftBasis: 'default-seed'`; samples gate covers the immature case.
- **No-op online updates** — `effectiveOnlineSamples` reads 0 when nothing moved,
  surfacing a silent no-op.
- **Immature shadow (<100 samples)** — served but pinned to heuristic; composite
  becomes heuristic-only (`reason:'samples'`).
- **Stale snapshots** — F20 once-per-rise capture + 60 s same-rise guard +
  512 KiB atomic compaction keep fire-time features fresh and the file bounded.
- **finalLoss** — real prequential EMA, no longer a misleading hardcoded 0.
- **File corruption / IO errors** — every read path (`loadCurrent`,
  `loadBaselineBias`, `loadModel`, tail/readAll) swallows parse errors and falls
  back rather than crashing; append failures are logged, not thrown.


---

