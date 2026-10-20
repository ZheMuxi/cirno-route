export class RoutingError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id;

// Called only for an enabled ordinary user turn, never by /classify.
export async function switchRecommendedModel(result, {
  getModels, getModel, setModel, isAvailable, isActive, signal, abort, state,
}) {
  const active = () => !signal?.aborted && isActive();
  if (!active()) return { status: 'skipped' };
  const route = result.routing;
  const row = result.candidates.find(c => c.candidate_id === route?.recommended_candidate_id);
  if (!row || result.source !== 'gemma' || result.status === 'blocked'
      || result.input_status === 'missing' || !Number.isInteger(row.quality_level)
      || row.quality_level < 3 || row.quality_level > 4 || !row.evidence_ids?.length
      || row.provider !== route.provider || row.model !== route.model) {
    throw new RoutingError('ROUTER_NO_SUITABLE_MODEL');
  }
  const model = getModels().find(m => m.provider === row.provider && m.id === row.model);
  if (!model) throw new RoutingError('ROUTER_MODEL_UNAVAILABLE');
  try {
    if (!await isAvailable(model)) throw new RoutingError('ROUTER_MODEL_UNAVAILABLE');
  } catch { throw new RoutingError('ROUTER_MODEL_UNAVAILABLE'); }
  if (!active()) return { status: 'skipped' };
  const outcome = { provider: model.provider, model: model.id,
    price_preference: route.price_preference, reason: route.reason };
  if (sameModel(getModel(), model)) return { ...outcome, status: 'unchanged' };
  // Model selection can await authentication. If cancellation/settings changes arrive meanwhile,
  // undo only our own selection; never replace a newer manual selection with the old model.
  state.restoreModel = getModel();
  state.switchingTo = model;
  let switched = false;
  try {
    switched = await setModel(model);
  } catch {
    // Some SDK errors can happen after model state changed. Restore below before falling back.
  } finally {
    state.switchingTo = null;
  }
  if (!active() || !switched || !sameModel(getModel(), model)) {
    if (sameModel(getModel(), model)) {
      const previous = state.restoreModel;
      state.switchingTo = previous;
      let restored = false;
      try { restored = !!previous && await setModel(previous) && sameModel(getModel(), previous); }
      catch {} finally { state.switchingTo = null; }
      if (!restored) {
        abort();
        throw new RoutingError('ROUTER_RESTORE_FAILED');
      }
    }
    if (!active()) return { status: 'skipped' };
    throw new RoutingError('ROUTER_SWITCH_FAILED');
  }
  return { ...outcome, status: 'switched' };
}
