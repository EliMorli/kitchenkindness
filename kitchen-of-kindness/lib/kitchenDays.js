// Kitchen progress for a delivery date (table kitchen_days), shown as the
// four-step tracker on the Kitchen Live page:
//   Cooking -> Packing (labels printed) -> Delivering (list copied to
//   WhatsApp) -> Delivered (marked by the admin).
// Printing and copying record themselves from the label page and the copy
// buttons; the admin can mark or undo any step by hand.

export const STAGES = [
  { key: 'cooking', field: null, emoji: '\u{1F373}', label: 'Cooking', hint: 'Meals on the stove' },
  { key: 'packing', field: 'printed_at', emoji: '\u{1F6CD}️', label: 'Packing', hint: 'Labels printed' },
  { key: 'delivering', field: 'copied_at', emoji: '\u{1F690}', label: 'Delivering', hint: 'List sent to WhatsApp' },
  { key: 'delivered', field: 'delivered_at', emoji: '✅', label: 'Delivered', hint: 'All bags dropped off' }
];

export function stageIndex(row) {
  if (!row) return 0;
  if (row.delivered_at) return 3;
  if (row.copied_at) return 2;
  if (row.printed_at) return 1;
  return 0;
}

export async function loadKitchenDay(supabase, dateStr) {
  const { data, error } = await supabase
    .from('kitchen_days')
    .select('*')
    .eq('delivery_date', dateStr)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Every print job records its time and label count, from the print tab as
// the job starts (every Print labels button opens that tab). A count is always
// written with the time, so an old count never sits next to a new print.
export async function markPrinted(supabase, dateStr, labelCount = null) {
  const { error } = await supabase
    .from('kitchen_days')
    .upsert(
      { delivery_date: dateStr, printed_at: new Date().toISOString(), printed_labels: labelCount },
      { onConflict: 'delivery_date' }
    );
  if (error) throw error;
}

// Sets one step's time only if it isn't set yet, so copying the list again
// later keeps the time it was first sent.
async function markOnce(supabase, dateStr, field) {
  const { error: insErr } = await supabase
    .from('kitchen_days')
    .upsert({ delivery_date: dateStr }, { onConflict: 'delivery_date', ignoreDuplicates: true });
  if (insErr) throw insErr;
  const { error } = await supabase
    .from('kitchen_days')
    .update({ [field]: new Date().toISOString() })
    .eq('delivery_date', dateStr)
    .is(field, null);
  if (error) throw error;
}

export const markCopied = (supabase, dateStr) => markOnce(supabase, dateStr, 'copied_at');
export const markDelivered = (supabase, dateStr) => markOnce(supabase, dateStr, 'delivered_at');

// Manual control from the tracker: mark step `index` done now (if it isn't),
// or undo it together with every later step.
export async function markStage(supabase, dateStr, index) {
  const field = STAGES[index]?.field;
  if (!field) return;
  await markOnce(supabase, dateStr, field);
}

export async function undoStage(supabase, dateStr, index) {
  const patch = {};
  STAGES.slice(Math.max(1, index)).forEach(s => {
    patch[s.field] = null;
    if (s.field === 'printed_at') patch.printed_labels = null;
  });
  const { error } = await supabase.from('kitchen_days').update(patch).eq('delivery_date', dateStr);
  if (error) throw error;
}

// Best-effort logging for buttons that already did their real job (copy,
// print). Never throws, so a logging hiccup can't break the button.
export async function logStage(fn, ...args) {
  try {
    await fn(...args);
    return true;
  } catch (e) {
    console.error('Could not record kitchen progress:', e);
    return false;
  }
}
