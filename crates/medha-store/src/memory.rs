use std::collections::HashMap;

use crate::errors::StoreError;
use crate::folding::{fold_episode_into_state, fold_log};
use crate::traits::StorePort;
use crate::types::{
    AppendResult, EntityKey, EntityState, Episode, EpisodeInput, EpisodePayload, OpenResult,
    ReplaceLogResult, StoreRegistries,
};

#[derive(Clone)]
pub struct MemoryStore {
    registries: StoreRegistries,
    log: Vec<Episode>,
    projection: HashMap<String, EntityState>,
    meta: HashMap<String, String>,
    next_seq: u64,
    opened: bool,
}

impl MemoryStore {
    pub fn new(registries: Option<StoreRegistries>) -> Self {
        Self {
            registries: registries.unwrap_or_default(),
            log: Vec::new(),
            projection: HashMap::new(),
            meta: HashMap::new(),
            next_seq: 0,
            opened: false,
        }
    }

    fn assert_open(&self, op: &'static str) -> Result<(), StoreError> {
        if !self.opened {
            return Err(StoreError::StoreClosed(op));
        }
        Ok(())
    }

    fn accept(&mut self, episode: Episode) -> Option<EntityState> {
        self.log.push(episode.clone());
        self.next_seq = episode.seq + 1;

        if let EpisodePayload::Retract { .. } = &episode.payload {
            self.projection = fold_log(&self.log);
            return self.projection.get(&episode.key.to_string_repr()).cloned();
        }

        let key_str = episode.key.to_string_repr();
        let curr = self.projection.remove(&key_str);
        if let Some(next) = fold_episode_into_state(curr, &episode) {
            self.projection.insert(key_str, next.clone());
            Some(next)
        } else {
            None
        }
    }
}

impl StorePort for MemoryStore {
    fn name(&self) -> &'static str {
        "memory"
    }

    fn registries(&self) -> &StoreRegistries {
        &self.registries
    }

    fn is_open(&self) -> bool {
        self.opened
    }

    fn open(&mut self) -> Result<OpenResult, StoreError> {
        self.opened = true;
        Ok(OpenResult::Ok)
    }

    fn close(&mut self) -> Result<(), StoreError> {
        self.opened = false;
        Ok(())
    }

    fn append(&mut self, input: EpisodeInput) -> Result<AppendResult, StoreError> {
        self.assert_open("append")?;
        let seq = self.next_seq;
        let episode = Episode {
            seq,
            key: input.key,
            at: input.at,
            author: input.author,
            payload: input.payload,
        };
        let state = self.accept(episode.clone());
        Ok(AppendResult { episode, state })
    }

    fn episodes(
        &self,
        after_seq: Option<i64>,
        limit: Option<usize>,
    ) -> Result<Vec<Episode>, StoreError> {
        self.assert_open("episodes")?;
        let from = after_seq.unwrap_or(-1);
        let filtered: Vec<Episode> = self
            .log
            .iter()
            .filter(|e| (e.seq as i64) > from)
            .cloned()
            .collect();

        if let Some(lim) = limit {
            Ok(filtered.into_iter().take(lim).collect())
        } else {
            Ok(filtered)
        }
    }

    fn get(&self, key: &EntityKey) -> Result<Option<EntityState>, StoreError> {
        self.assert_open("get")?;
        Ok(self.projection.get(&key.to_string_repr()).cloned())
    }

    fn list(&self) -> Result<Vec<EntityState>, StoreError> {
        self.assert_open("list")?;
        let mut states: Vec<EntityState> = self.projection.values().cloned().collect();
        states.sort_by_key(|a| a.key.to_string_repr());
        Ok(states)
    }

    fn rebuild(&mut self) -> Result<Vec<EntityState>, StoreError> {
        self.assert_open("rebuild")?;
        self.projection = fold_log(&self.log);
        let mut states: Vec<EntityState> = self.projection.values().cloned().collect();
        states.sort_by_key(|a| a.key.to_string_repr());
        Ok(states)
    }

    fn replace_log(&mut self, episodes: &[Episode]) -> Result<ReplaceLogResult, StoreError> {
        self.assert_open("replace_log")?;
        let from = 0;
        let to = if self.log.is_empty() {
            0
        } else {
            self.log.len() as u64 - 1
        };

        self.log.clear();
        self.projection.clear();
        self.next_seq = 0;

        for ep in episodes {
            self.accept(ep.clone());
        }

        Ok(ReplaceLogResult { from, to })
    }

    fn get_meta(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.assert_open("get_meta")?;
        Ok(self.meta.get(key).cloned())
    }

    fn set_meta(&mut self, key: &str, value: &str) -> Result<(), StoreError> {
        self.assert_open("set_meta")?;
        self.meta.insert(key.to_string(), value.to_string());
        Ok(())
    }
}
