/**
 * v0.85.0 — the shared "this is a model-driven prediction" marker.
 *
 * The Predictive tab was dissolved and its sections scattered onto their home
 * pages (Solar / Battery / Strategy / Dashboard). This badge is the CONSISTENCY
 * mechanism: every relocated forecast/projection/model section wears the same
 * small pill so an operator can tell at a glance which numbers are *predicted*
 * (and how much to trust them) versus which are live telemetry.
 *
 * Styling is token-only (bg-accent/15 text-accent) so it reads correctly in
 * both the Default and Babylon-5 themes. It never carries a status colour — a
 * prediction being uncertain is not an alarm condition.
 */

export type PredictiveKind = 'forecast' | 'projection' | 'model' | 'prediction';

/**
 * A tiny neutral chip stating how accurate a prediction is — e.g. "±12%",
 * "R² 0.87", or "calibrating". Rendered inside PredictiveBadge, but exported so
 * a section that wants the accuracy on its own (a table header cell, say) can
 * use it directly.
 */
export function AccuracyChip({ accuracy, title }: { accuracy?: string | null; title?: string }) {
  const text = accuracy && accuracy.trim() ? accuracy : 'calibrating';
  return (
    <span
      className="text-[10px] font-mono tabular-nums normal-case tracking-normal text-accent/90 bg-accent/10 border border-accent/25 rounded px-1 py-px"
      title={title}
    >
      {text}
    </span>
  );
}

/**
 * The predictive marker pill. Renders the kind in small caps ("FORECAST"),
 * optionally followed by an accuracy chip.
 *
 * @param kind      what sort of prediction this is (defaults to 'forecast').
 * @param accuracy  a pre-formatted accuracy string (e.g. "±12% · R² 0.87").
 *                  Omit / empty ⇒ the chip reads "calibrating" instead of a
 *                  fabricated number. Pass `null` to suppress the chip entirely.
 * @param title     tooltip on the pill (what the model does / how it's fitted).
 */
export function PredictiveBadge({
  kind = 'forecast',
  accuracy,
  title,
}: {
  kind?: PredictiveKind;
  accuracy?: string | null;
  title?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0" title={title}>
      <span className="badge bg-accent/15 text-accent border-accent/30 text-[9px]">{kind}</span>
      {accuracy !== null && <AccuracyChip accuracy={accuracy} title={title} />}
    </span>
  );
}
