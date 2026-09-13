// Correlate each close attempt and keep service timeouts separate from the
// user's confirmation. A delayed response must never approve a later attempt.
#[derive(Default)]
pub struct CloseState {
    pending: Option<Pending>,
}

struct Pending {
    id: String,
    exit: bool,
    checking: bool,
}

impl CloseState {
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    pub fn begin(&mut self, id: String, exit: bool) -> bool {
        if let Some(pending) = &mut self.pending {
            pending.exit |= exit;
            return false;
        }
        self.pending = Some(Pending {
            id,
            exit,
            checking: true,
        });
        true
    }

    pub fn confirm(&mut self, id: &str) -> bool {
        let Some(pending) = &mut self.pending else {
            return false;
        };
        if pending.id != id || !pending.checking {
            return false;
        }
        pending.checking = false;
        true
    }

    pub fn finish(&mut self, id: &str) -> Option<bool> {
        if self.pending.as_ref()?.id != id {
            return None;
        }
        self.pending.take().map(|pending| pending.exit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_replies_cannot_close_a_retried_window() {
        let mut state = CloseState::default();
        assert!(state.begin("first".into(), true));
        assert!(state.confirm("first"));
        assert_eq!(state.finish("first"), Some(true));
        assert!(state.begin("retry".into(), false));
        assert!(!state.confirm("first"));
        assert_eq!(state.finish("first"), None);
        assert!(state.is_pending());
        assert!(state.confirm("retry"));
        assert_eq!(state.finish("retry"), Some(false));
    }

    #[test]
    fn a_service_timeout_cannot_replace_a_user_confirmation() {
        let mut state = CloseState::default();
        assert!(state.begin("request".into(), false));
        assert!(state.confirm("request"));
        // Timeout, duplicate report and late success all claim the same phase.
        assert!(!state.confirm("request"));
        assert!(state.is_pending());
        assert_eq!(state.finish("request"), Some(false));
        assert!(!state.is_pending());
    }

    #[test]
    fn quit_upgrades_the_pending_attempt_without_opening_another_dialog() {
        let mut state = CloseState::default();
        assert!(state.begin("close".into(), false));
        assert!(!state.begin("quit".into(), true));
        assert!(state.confirm("close"));
        assert_eq!(state.finish("close"), Some(true));
        assert!(state.begin("next".into(), false));
        assert_eq!(state.finish("next"), Some(false));
    }
}
