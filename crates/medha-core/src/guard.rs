use crate::types::GuardState;

/// Guard factor G according to docs/spec/trust-formula.md §4.2:
/// - Unguarded (kind is "" or "none"): 0.5
/// - Guarded, last_ok == false: 0.0
/// - Guarded, last_ok == true: 1.0
/// - Guarded, last_ok == None (never reported): 0.8
pub fn guard_factor(guard: &GuardState) -> f64 {
    if guard.kind.is_empty() || guard.kind == "none" {
        0.5
    } else {
        match guard.last_ok {
            Some(false) => 0.0,
            Some(true) => 1.0,
            None => 0.8,
        }
    }
}

pub fn is_guarded(guard: &GuardState) -> bool {
    !guard.kind.is_empty() && guard.kind != "none"
}
